from __future__ import annotations

import asyncio
import inspect
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from .openai_compat import ModelError
from .prompt import system_prompt
from .seed import User
from .store import Event, Store
from .tools import Tool, ToolContext, ToolError
from .types import ChatModel, Message, ModelRequest, ToolCall, dumps

# 对应 src/agent.ts：Agent 循环。每一步都先写事件再继续，进程崩溃后再次调用 run_agent 即可从断点恢复。
# 与 TS 版的主要差别在取消：TS 把 AbortSignal 一层层传下去；asyncio 由 task.cancel() 在 await 点抛出
# CancelledError。用 task.cancel(SHUTDOWN) 表示服务要重启（run 保持 running，重启后接着跑）。
# 本移植没有包含第 13 章的上下文裁剪和第 15 章的降级链。

SHUTDOWN = 'shutdown'
TERMINAL_STATUSES = ('completed', 'failed', 'cancelled', 'budget_exceeded')


@dataclass
class AgentOptions:
    model: ChatModel
    store: Store
    tools: list[Tool]
    # 一个 run 最多调用模型几次。防止模型陷入循环、无限花钱
    max_steps: int = 8
    # 一个 run 最多消耗多少 token。调用前检查
    max_tokens: int = 60_000
    max_output_tokens: int = 2_000
    approval_ttl_s: float = 30 * 60
    on_delta: Callable[[str, str], None] | None = None


async def run_agent(run_id: str, user: User, options: AgentOptions) -> str:
    """执行（或继续执行）一个 run，直到完成、失败、取消，或需要用户审批而暂停。返回 run 的状态。"""
    store, model = options.store, options.model
    run = store.get_run(run_id)
    if not run or run.user_id != user.id or run.tenant_id != user.tenant_id:
        raise LookupError(f'run {run_id} 不存在')
    if run.status != 'running':
        return run.status

    tools = {tool.name: tool for tool in options.tools}

    def finish(status: str, reason: str | None = None) -> str:
        with store.transaction():
            store.append(run_id, 'run_finished', {'status': status, **({'reason': reason} if reason else {})})
            store.set_status(run_id, status)
        return status

    try:
        while True:
            events = store.events(run_id)
            pending = pending_tool_calls(events)

            if pending:
                # 相邻的只读调用并发执行；写操作是顺序屏障，审批暂停时后面的调用都不执行
                for batch in execution_batches(pending, tools):
                    outcomes = await asyncio.gather(
                        *(_execute_tool_call(call, events, tools, user, run_id, options) for call in batch),
                        return_exceptions=True,
                    )
                    for outcome in outcomes:
                        if isinstance(outcome, BaseException):
                            raise outcome
                    if 'paused' in outcomes:
                        store.set_status(run_id, 'waiting_approval')
                        return 'waiting_approval'
                continue

            last_answer = next((e for e in reversed(events) if e.type == 'assistant_message'), None)
            if events[-1].type == 'usage' and last_answer and not last_answer.data['toolCalls']:
                return finish('completed')

            steps = sum(1 for e in events if e.type == 'assistant_message')
            if steps >= options.max_steps:
                return finish('budget_exceeded', f'超过最大步数 {options.max_steps}')
            used = usage_of(events)
            remaining = options.max_tokens - used['inputTokens'] - used['outputTokens']
            if remaining <= 0:
                return finish('budget_exceeded', f'超过 token 预算 {options.max_tokens}')

            started = time.monotonic()
            response = await model.complete(ModelRequest(
                messages=[Message('system', system_prompt(user)), *to_model_messages(events)],
                tools=[tool.spec for tool in options.tools],
                max_output_tokens=min(options.max_output_tokens, remaining),
                on_text=(lambda delta: options.on_delta(run_id, delta)) if options.on_delta else None,
            ))
            latency_ms = round((time.monotonic() - started) * 1000)
            model_name = response.model or model.name
            # 被截断的回复里，工具参数可能只生成了一半，绝不能执行
            truncated = response.finish_reason == 'length'
            tool_calls = [] if truncated else list(response.message.tool_calls)
            final = ('failed', '模型输出被长度截断') if truncated else (('completed', None) if not tool_calls else None)

            # 最终回答、用量和结束状态在同一个事务里提交：崩溃后要么都在，要么都不在
            with store.transaction():
                store.append(run_id, 'assistant_message', {'content': response.message.content, 'toolCalls': [c.to_json() for c in tool_calls]})
                usage = {'model': model_name, 'inputTokens': response.usage.input_tokens, 'outputTokens': response.usage.output_tokens}
                if response.usage.estimated:
                    usage['estimated'] = True
                store.append(run_id, 'usage', {**usage, 'latencyMs': latency_ms})
                if final:
                    store.append(run_id, 'run_finished', {'status': final[0], **({'reason': final[1]} if final[1] else {})})
                    store.set_status(run_id, final[0])
            if final:
                return final[0]
    except asyncio.CancelledError as cancel:
        # 服务重启引起的中断：保持 running，重启后接着跑
        if SHUTDOWN not in cancel.args:
            finish('cancelled', '用户取消')
        # 必须继续抛出：吞掉 CancelledError 会让 asyncio.timeout、TaskGroup 等依赖取消的机制失效
        raise
    except Exception as error:  # noqa: BLE001
        # 不把内部错误细节暴露给前端，详细信息看服务端日志
        return finish('failed', f'模型服务错误（{error.status}）' if isinstance(error, ModelError) else '内部错误')


async def _execute_tool_call(call: ToolCall, events: list[Event], tools: dict[str, Tool], user: User, run_id: str, options: AgentOptions) -> str:
    store = options.store

    def fail(code: str, message: str) -> str:
        store.append(run_id, 'tool_finished', {'callId': call.id, 'name': call.name, 'ok': False, 'error': {'code': code, 'message': message}})
        return 'done'

    tool = tools.get(call.name)
    if not tool:
        return fail('UNKNOWN_TOOL', f'没有名为 {call.name} 的工具')

    try:
        args = tool.parse(json.loads(call.arguments or '{}'))
    except ToolError as error:
        return fail('INVALID_ARGUMENTS', error.message)
    except ValueError:
        return fail('INVALID_ARGUMENTS', '参数不是合法 JSON')

    context = ToolContext(user, run_id, call.id)
    if tool.requires_approval:
        decision = next((e for e in events if e.type == 'approval_resolved' and e.data['callId'] == call.id), None)
        if not decision:
            requested = any(e.type == 'approval_requested' and e.data['callId'] == call.id for e in events)
            if not requested:
                expires = datetime.now(timezone.utc) + timedelta(seconds=options.approval_ttl_s)
                store.append(run_id, 'approval_requested', {
                    'callId': call.id,
                    'name': call.name,
                    'args': args,
                    'summary': tool.describe(args, context) if tool.describe else f'{call.name} {call.arguments}',
                    'expiresAt': expires.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                })
            return 'paused'
        if not decision.data['approved']:
            if decision.data.get('reason') == 'expired':
                return fail('APPROVAL_EXPIRED', '确认已超时，操作未执行')
            return fail('APPROVAL_REJECTED', '员工拒绝了这个操作，操作未执行')

    store.append(run_id, 'tool_started', {'callId': call.id, 'name': call.name, 'args': args})
    try:
        result = tool.run(args, context)
        if inspect.isawaitable(result):
            result = await result
        store.append(run_id, 'tool_finished', {'callId': call.id, 'name': call.name, 'ok': True, 'result': result})
    except ToolError as error:
        fail(error.code, error.message)
    except Exception:  # noqa: BLE001  CancelledError 是 BaseException，不会被这里吞掉
        fail('INTERNAL_ERROR', '工具执行失败，请稍后再试')
    return 'done'


def execution_batches(calls: list[ToolCall], tools: dict[str, Tool]) -> list[list[ToolCall]]:
    """相邻的只读调用合成一批并发执行，其余每个调用单独一批。"""
    batches: list[list[ToolCall]] = []
    for call in calls:
        read_only = call.name in tools and tools[call.name].read_only
        if read_only and batches and batches[-1][0].name in tools and tools[batches[-1][0].name].read_only:
            batches[-1].append(call)
        else:
            batches.append([call])
    return batches


def pending_tool_calls(events: list[Event]) -> list[ToolCall]:
    """最后一条模型消息中，还没有结果的工具调用（包括崩溃时执行到一半的）。"""
    last = next((e for e in reversed(events) if e.type == 'assistant_message'), None)
    if not last:
        return []
    finished = {e.data['callId'] for e in events if e.type == 'tool_finished'}
    return [ToolCall.from_json(c) for c in last.data['toolCalls'] if c['id'] not in finished]


def to_model_messages(events: list[Event]) -> list[Message]:
    """从事件日志重建发给模型的对话历史；工具结果按模型给出调用的顺序排列。"""
    messages: list[Message] = []
    order: dict[str, int] = {}
    results: list[tuple[int, Message]] = []

    def flush() -> None:
        messages.extend(message for _, message in sorted(results, key=lambda item: item[0]))
        results.clear()

    for event in events:
        if event.type == 'run_started':
            flush()
            messages.append(Message('user', event.data['question']))
        elif event.type == 'assistant_message':
            flush()
            calls = tuple(ToolCall.from_json(c) for c in event.data['toolCalls'])
            order = {call.id: index for index, call in enumerate(calls)}
            messages.append(Message('assistant', event.data['content'], calls))
        elif event.type == 'tool_finished':
            data = event.data
            payload: dict[str, Any] = {'ok': True, 'data': data.get('result')} if data['ok'] else {'ok': False, 'error': data['error']}
            results.append((order.get(data['callId'], len(order)), Message('tool', dumps(payload), tool_call_id=data['callId'])))
    flush()
    return messages


def usage_of(events: list[Event]) -> dict[str, int]:
    total = {'inputTokens': 0, 'outputTokens': 0, 'latencyMs': 0, 'modelCalls': 0}
    for event in events:
        if event.type == 'usage':
            total['inputTokens'] += event.data['inputTokens']
            total['outputTokens'] += event.data['outputTokens']
            total['latencyMs'] += event.data['latencyMs']
            total['modelCalls'] += 1
    return total


def estimate_cost(usage: dict[str, int], price_input: float, price_output: float) -> float:
    return (usage['inputTokens'] * price_input + usage['outputTokens'] * price_output) / 1_000_000


def resolve_approval(store: Store, run_id: str, user: User, call_id: str, approved: bool, now: datetime | None = None) -> dict[str, Any]:
    """记录用户的审批决定。只有 run 的发起人能审批；过期的审批按拒绝处理。"""
    run = store.get_run(run_id)
    if not run or run.user_id != user.id or run.tenant_id != user.tenant_id:
        return {'ok': False, 'code': 'NOT_FOUND'}
    if run.status != 'waiting_approval':
        return {'ok': False, 'code': 'NOT_WAITING'}
    events = store.events(run_id)
    request = next((e for e in events if e.type == 'approval_requested' and e.data['callId'] == call_id), None)
    if not request:
        return {'ok': False, 'code': 'NOT_FOUND'}
    if any(e.type == 'approval_resolved' and e.data['callId'] == call_id for e in events):
        return {'ok': False, 'code': 'ALREADY_RESOLVED'}

    expired = (now or datetime.now(timezone.utc)) > datetime.fromisoformat(request.data['expiresAt'])
    final_decision = approved and not expired
    with store.transaction():
        store.append(run_id, 'approval_resolved', {
            'callId': call_id, 'approved': final_decision, 'userId': user.id, **({'reason': 'expired'} if expired else {}),
        })
        store.set_status(run_id, 'running')
    return {'ok': True, 'approved': final_decision}


def cancel_idle_run(store: Store, run_id: str) -> bool:
    """取消一个没有在执行中的 run（例如正在等待审批）。"""
    run = store.get_run(run_id)
    if not run or run.status in TERMINAL_STATUSES:
        return False
    with store.transaction():
        store.append(run_id, 'run_finished', {'status': 'cancelled', 'reason': '用户取消'})
        store.set_status(run_id, 'cancelled')
    return True
