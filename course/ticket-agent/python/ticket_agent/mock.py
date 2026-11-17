from __future__ import annotations

import asyncio
import itertools
import json
import math
import re
from collections.abc import Callable
from typing import Any

from .types import Message, ModelRequest, ModelResponse, ToolCall, Usage, dumps

# 对应 src/llm/mock.ts。离线假模型：不联网、不需要 API key、每次结果相同。
# 用关键词规则模仿“先检索 → 再拟工单 → 再创建”的决策；它不理解语言，不能用来评估效果。

_WANTS_TICKET = re.compile('工单|报修|提交|申请')
_call_counter = itertools.count(1)


class MockModel:
    name = 'mock'

    def __init__(self, delay_s: float = 0) -> None:
        self._delay_s = delay_s

    async def complete(self, request: ModelRequest) -> ModelResponse:
        message = _decide(request.messages, [tool['name'] for tool in request.tools])
        await _stream_text(message.content, request, self._delay_s)
        return _respond(request.messages, message)


Reply = dict[str, Any]


class ScriptedModel:
    """测试专用：按顺序返回预先写好的回复。回复用完还被调用会直接报错，暴露多余的模型调用。"""

    name = 'scripted'

    def __init__(self, replies: list[Reply | Callable[[list[Message]], Reply]]) -> None:
        self._replies = replies
        self._index = 0

    async def complete(self, request: ModelRequest) -> ModelResponse:
        self._index += 1
        if self._index > len(self._replies):
            raise RuntimeError(f'脚本模型的回复已用完（第 {self._index} 次调用）')
        reply = self._replies[self._index - 1]
        if callable(reply):
            reply = reply(request.messages)
        calls = tuple(
            ToolCall(f'call_{self._index}_{i}', call['name'], dumps(call['args'])) for i, call in enumerate(reply.get('tool_calls', []))
        )
        message = Message('assistant', reply.get('content', ''), calls)
        await _stream_text(message.content, request, 0)
        return _respond(request.messages, message)


def _decide(messages: list[Message], tools: list[str]) -> Message:
    last_user = max((i for i, m in enumerate(messages) if m.role == 'user'), default=-1)
    question = messages[last_user].content if last_user >= 0 else ''
    if not tools:
        return _text(f'（离线模拟模型）收到你的问题：“{question}”。设置 MODEL_PROVIDER=openai 后将由真实模型回答。')

    results = _tool_results(messages[last_user + 1:])
    search = results.get('search_knowledge')
    draft = results.get('prepare_ticket')
    created = results.get('create_ticket')
    wants_ticket = bool(_WANTS_TICKET.search(question))

    if not search and 'search_knowledge' in tools:
        return _call('search_knowledge', {'query': question})
    hits = search['data']['results'] if search and search['ok'] else []
    if wants_ticket and not draft and 'prepare_ticket' in tools:
        return _call('prepare_ticket', {
            'title': question[:40],
            'description': f'员工请求：{question}',
            'sourceIds': [hit['sourceId'] for hit in hits],
        })
    if wants_ticket and draft and draft['ok'] and not created and 'create_ticket' in tools:
        return _call('create_ticket', {'draftId': draft['data']['draftId']})

    parts = [f"根据《{hits[0]['title']}》[{hits[0]['sourceId']}]：{hits[0]['snippet']}"] if hits else [
        '没有找到你有权限查看的相关制度，无法给出确定答案。建议咨询人事或提交工单。'
    ]
    if created and created['ok']:
        parts.append(f"工单已创建，编号 {created['data']['ticketId']}。")
    elif created and (created.get('error') or {}).get('code') == 'APPROVAL_REJECTED':
        parts.append('你拒绝了创建工单，没有提交任何工单。')
    elif created:
        parts.append(f"工单创建失败：{(created.get('error') or {}).get('message', '未知错误')}")
    return _text('\n'.join(parts))


def _tool_results(turn: list[Message]) -> dict[str, dict[str, Any]]:
    names: dict[str, str] = {}
    results: dict[str, dict[str, Any]] = {}
    for message in turn:
        if message.role == 'assistant':
            names.update({call.id: call.name for call in message.tool_calls})
        if message.role == 'tool' and message.tool_call_id in names:
            results[names[message.tool_call_id]] = json.loads(message.content)
    return results


def _call(name: str, args: Any) -> Message:
    return Message('assistant', '', (ToolCall(f'mock_{next(_call_counter)}', name, dumps(args)),))


def _text(content: str) -> Message:
    return Message('assistant', content)


async def _stream_text(content: str, request: ModelRequest, delay_s: float) -> None:
    for i in range(0, len(content), 4):
        if request.on_text:
            request.on_text(content[i:i + 4])
        # sleep(0) 也是一个 await 点：没有它，一个长循环会霸占事件循环，取消也要等它跑完
        await asyncio.sleep(delay_s)


# 假模型没有真实 token 数，用字符数粗略估算，只为让用量统计链路可测
def _respond(messages: list[Message], message: Message) -> ModelResponse:
    input_chars = sum(len(m.content) for m in messages)
    return ModelResponse(
        message=message,
        usage=Usage(math.ceil(input_chars / 2), math.ceil((len(message.content) + 20) / 2)),
        finish_reason='tool_calls' if message.tool_calls else 'stop',
    )
