import asyncio
import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ticket_agent.agent import SHUTDOWN, AgentOptions, resolve_approval, run_agent
from ticket_agent.mock import MockModel, ScriptedModel
from ticket_agent.seed import find_user
from ticket_agent.store import Store
from ticket_agent.tools import Tool, create_tools
from ticket_agent.types import ModelRequest, ModelResponse

ALICE = find_user('alice')


def tool_results(messages):
    return [json.loads(m.content) for m in messages if m.role == 'tool']


class AgentLoopTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.store = Store()

    def tearDown(self):
        self.store.close()

    def options(self, model, **kwargs):
        return AgentOptions(model=model, store=self.store, tools=create_tools(self.store), **kwargs)

    async def test_tool_loop_feeds_results_back_and_rejects_bad_arguments(self):
        seen = {}

        def answer(messages):
            seen['results'] = tool_results(messages)
            return {'content': '根据 [acme-travel@v2]：500 元'}

        model = ScriptedModel([
            {'tool_calls': [{'name': 'search_knowledge', 'args': {'query': '差旅住宿报销上限'}},
                            {'name': 'search_knowledge', 'args': {'query': ''}},
                            {'name': 'delete_everything', 'args': {}}]},
            answer,
        ])
        run = self.store.create_run(ALICE, '出差住宿能报多少？')
        self.assertEqual(await run_agent(run.id, ALICE, self.options(model)), 'completed')
        ok, invalid, unknown = seen['results']
        self.assertEqual(ok['data']['results'][0]['sourceId'], 'acme-travel@v2')
        self.assertEqual(invalid['error']['code'], 'INVALID_ARGUMENTS')
        self.assertEqual(unknown['error']['code'], 'UNKNOWN_TOOL')
        types = [e.type for e in self.store.events(run.id)]
        self.assertEqual(types.count('usage'), 2)
        self.assertEqual(types[-1], 'run_finished')

    async def test_adjacent_read_only_calls_run_concurrently(self):
        running = 0
        peak = 0

        async def slow_search(args, ctx):
            nonlocal running, peak
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(0.01)
            running -= 1
            return {'results': []}

        spec = {'name': 'slow_search', 'description': '', 'parameters': {'type': 'object'}}
        tool = Tool(spec=spec, parse=lambda args: args, run=slow_search, read_only=True)
        model = ScriptedModel([{'tool_calls': [{'name': 'slow_search', 'args': {}}] * 3}, {'content': 'ok'}])
        run = self.store.create_run(ALICE, 'q')
        await run_agent(run.id, ALICE, AgentOptions(model=model, store=self.store, tools=[tool]))
        self.assertEqual(peak, 3)

    async def test_max_steps_stops_a_looping_model(self):
        model = ScriptedModel([{'tool_calls': [{'name': 'search_knowledge', 'args': {'query': 'VPN'}}]}] * 3)
        run = self.store.create_run(ALICE, 'VPN')
        self.assertEqual(await run_agent(run.id, ALICE, self.options(model, max_steps=2)), 'budget_exceeded')


class ApprovalTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.store = Store()
        self.options = AgentOptions(model=MockModel(), store=self.store, tools=create_tools(self.store))

    def tearDown(self):
        self.store.close()

    async def start(self):
        run = self.store.create_run(ALICE, 'VPN 连不上，帮我提交 IT 工单')
        status = await run_agent(run.id, ALICE, self.options)
        request = next(e for e in self.store.events(run.id) if e.type == 'approval_requested')
        return run, status, request

    async def test_ticket_is_created_only_after_approval_and_only_once(self):
        run, status, request = await self.start()
        self.assertEqual(status, 'waiting_approval')
        self.assertEqual(self.store.tickets('acme'), [])
        self.assertIn('VPN', request.data['summary'])
        # 再跑一次也不会越过审批
        self.assertEqual(await run_agent(run.id, ALICE, self.options), 'waiting_approval')
        self.assertEqual(self.store.tickets('acme'), [])

        self.assertEqual(resolve_approval(self.store, run.id, find_user('carol'), request.data['callId'], True)['code'], 'NOT_FOUND')
        self.assertTrue(resolve_approval(self.store, run.id, ALICE, request.data['callId'], True)['approved'])
        self.assertEqual(await run_agent(run.id, ALICE, self.options), 'completed')
        [ticket] = self.store.tickets('acme')
        answer = [e for e in self.store.events(run.id) if e.type == 'assistant_message'][-1].data['content']
        self.assertIn(ticket.id, answer)
        self.assertEqual(resolve_approval(self.store, run.id, ALICE, request.data['callId'], True)['code'], 'NOT_WAITING')

    async def test_rejected_or_expired_approval_creates_nothing(self):
        run, _, request = await self.start()
        late = datetime.now(timezone.utc) + timedelta(hours=1)
        self.assertFalse(resolve_approval(self.store, run.id, ALICE, request.data['callId'], True, now=late)['approved'])
        self.assertEqual(await run_agent(run.id, ALICE, self.options), 'completed')
        self.assertEqual(self.store.tickets('acme'), [])
        failures = [e.data['error']['code'] for e in self.store.events(run.id) if e.type == 'tool_finished' and not e.data['ok']]
        self.assertEqual(failures, ['APPROVAL_EXPIRED'])


class SlowModel:
    name = 'slow'

    async def complete(self, request: ModelRequest) -> ModelResponse:
        await asyncio.sleep(10)
        raise AssertionError('unreachable')


class CancellationAndPersistenceTest(unittest.IsolatedAsyncioTestCase):
    async def test_user_cancel_finishes_run_and_shutdown_keeps_it_running(self):
        store = Store()
        try:
            options = AgentOptions(model=SlowModel(), store=store, tools=create_tools(store))
            for reason, expected in ((None, 'cancelled'), (SHUTDOWN, 'running')):
                run = store.create_run(ALICE, 'q')
                task = asyncio.create_task(run_agent(run.id, ALICE, options))
                await asyncio.sleep(0.01)
                task.cancel(reason)
                # 取消必须继续向上传播，调用方（asyncio.timeout、TaskGroup）才能感知
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertEqual(store.get_run(run.id).status, expected)
        finally:
            store.close()

    async def test_resumes_from_sqlite_file_after_crash_without_repeating_tool_calls(self):
        tmp = tempfile.mkdtemp()
        path = str(Path(tmp) / 'agent.db')
        try:
            store = Store(path)
            run = store.create_run(ALICE, 'VPN 连不上怎么办')
            # 模拟崩溃：模型已经要求调用工具，但进程在执行工具前退出
            store.append(run.id, 'assistant_message', {'content': '', 'toolCalls': [
                {'id': 'c1', 'name': 'search_knowledge', 'arguments': '{"query":"VPN 连不上"}'}]})
            store.append(run.id, 'usage', {'model': 'mock', 'inputTokens': 1, 'outputTokens': 1, 'latencyMs': 0})
            store.close()

            store = Store(path)
            options = AgentOptions(model=MockModel(), store=store, tools=create_tools(store))
            self.assertEqual(await run_agent(run.id, ALICE, options), 'completed')
            events = store.events(run.id)
            self.assertEqual(sum(1 for e in events if e.type == 'tool_started'), 1)
            self.assertIn('[acme-vpn@v1]', [e for e in events if e.type == 'assistant_message'][-1].data['content'])
            store.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
