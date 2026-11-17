from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from .agent import AgentOptions, resolve_approval, run_agent, usage_of
from .evaluate import EVAL_CASES, gate, run_case
from .mock import MockModel
from .openai_compat import OpenAICompatibleModel
from .seed import USERS, find_user
from .store import Store
from .tools import create_tools
from .types import dumps

# 命令行入口（在 course/ticket-agent/python 目录下运行）：
#   python -m ticket_agent chat --user alice
#   python -m ticket_agent eval        失败时退出码为 1，可直接放进 CI


def load_env_file(path: Path) -> None:
    """极简 .env 读取（不覆盖已有环境变量），与 node --env-file-if-exists 的用法对应。正式项目可用 python-dotenv。"""
    if not path.is_file():
        return
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"\''))


def create_model():
    provider = os.environ.get('MODEL_PROVIDER', 'mock')
    if provider == 'mock':
        # 与 TS 版一样每 4 个字停 15ms，模拟打字机效果
        return MockModel(delay_s=0.015)
    if provider != 'openai':
        raise SystemExit(f'MODEL_PROVIDER 只能是 mock 或 openai，当前是 {provider}')
    api_key = os.environ.get('LLM_API_KEY', '')
    if not api_key:
        raise SystemExit('MODEL_PROVIDER=openai 时必须设置 LLM_API_KEY')
    return OpenAICompatibleModel(
        os.environ.get('LLM_BASE_URL', 'https://api.deepseek.com'), api_key, os.environ.get('LLM_MODEL', 'deepseek-chat'))


async def chat(user_id: str) -> None:
    user = find_user(user_id)
    if not user:
        raise SystemExit(f"未知用户 {user_id}，可选：{', '.join(u.id for u in USERS)}")
    store = Store(os.environ.get('DATABASE_PATH', ':memory:'))
    model = create_model()
    options = AgentOptions(model=model, store=store, tools=create_tools(store),
                           on_delta=lambda _run, text: print(text, end='', flush=True))

    def on_event(event) -> None:
        if event.type == 'tool_started':
            print(f"\n  → 调用工具 {event.data['name']} {dumps(event.data['args'])}")
        if event.type == 'tool_finished':
            error = event.data.get('error') or {}
            print('  ← 成功' if event.data['ok'] else f"  ← 失败 {error.get('code')}: {error.get('message')}")

    store.on_event(on_event)
    print(f'模型：{model.name}　用户：{user.name}　输入 exit 退出')
    try:
        while True:
            # input() 是阻塞调用，直接在协程里用会卡住整个事件循环；放进线程里等
            question = (await asyncio.to_thread(input, '\n你> ')).strip()
            if not question:
                continue
            if question == 'exit':
                break
            run = store.create_run(user, question)
            print('Agent> ', end='', flush=True)
            status = await run_agent(run.id, user, options)
            while status == 'waiting_approval':
                request = next(e for e in reversed(store.events(run.id)) if e.type == 'approval_requested')
                print(f"\n\n需要你确认：\n{request.data['summary']}")
                answer = (await asyncio.to_thread(input, '确认执行？(y/N) ')).strip().lower()
                resolve_approval(store, run.id, user, request.data['callId'], answer == 'y')
                print('Agent> ', end='', flush=True)
                status = await run_agent(run.id, user, options)
            usage = usage_of(store.events(run.id))
            print(f"\n[{status}] 模型调用 {usage['modelCalls']} 次，token {usage['inputTokens']}+{usage['outputTokens']}")
    except EOFError:
        pass
    finally:
        store.close()


async def evaluate() -> int:
    model = create_model()
    print(f"评测模型：{'mock（离线模拟）' if model.name == 'mock' else model.name}，检索：keyword，共 {len(EVAL_CASES)} 条用例\n")
    results = []
    for case in EVAL_CASES:
        result = await run_case(case, model)
        results.append(result)
        print(f"{'PASS' if result.passed else 'FAIL'}  {'[critical] ' if result.critical else ''}{result.id}  {result.latency_ms}ms")
        for failure in result.failures:
            print(f'      - {failure}')
    report = gate(results, float(os.environ.get('LLM_PRICE_INPUT', 0)), float(os.environ.get('LLM_PRICE_OUTPUT', 0)))
    print(f"""
通过率：{report.pass_rate * 100:.0f}%（门槛 90%）
critical 失败：{', '.join(report.critical_failures) or '无'}
token 总量：{report.total_tokens}　估算成本：{report.cost:.4f} 元（按 .env 中的单价）
延迟：p50 {report.p50_ms}ms　p95 {report.p95_ms}ms
结论：{'✅ 可以发布' if report.passed else '❌ 禁止发布'}""")
    return 0 if report.passed else 1


def main(argv: list[str] | None = None) -> int:
    # 输入输出被重定向（CI、管道）时，Windows 上默认编码不是 UTF-8，读写中文会乱码或抛 UnicodeEncodeError
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(prog='python -m ticket_agent')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('chat', help='命令行对话（含审批）').add_argument('--user', default='alice')
    commands.add_parser('eval', help='评测门禁，不达标时退出码为 1')
    args = parser.parse_args(argv)
    load_env_file(Path(__file__).resolve().parents[2] / '.env')
    if args.command == 'chat':
        asyncio.run(chat(args.user))
        return 0
    return asyncio.run(evaluate())


if __name__ == '__main__':
    sys.exit(main())
