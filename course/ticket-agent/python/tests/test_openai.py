import asyncio
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from ticket_agent.openai_compat import ModelError, OpenAICompatibleModel
from ticket_agent.types import Message, ModelRequest


def sse(obj) -> bytes:
    return f'data: {json.dumps(obj, ensure_ascii=False)}\n\n'.encode('utf-8')


TEXT = sse({'choices': [{'delta': {'content': '你好'}}]})
FIRST_TOOL_CHUNK = sse({'choices': [{'delta': {'tool_calls': [{'index': 0, 'id': 'call_1', 'function': {'name': 'search_knowledge', 'arguments': '{"query":'}}]}}]})
TOOL_CALL = (
    FIRST_TOOL_CHUNK
    + sse({'choices': [{'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': '"差旅"}'}}]}, 'finish_reason': 'tool_calls'}]})
    + sse({'choices': [], 'usage': {'prompt_tokens': 120, 'completion_tokens': 9}})
    + b'data: [DONE]\n\n'
)


class FakeProvider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        server = self.server
        server.bodies.append(json.loads(self.rfile.read(int(self.headers['content-length']))))
        behavior = server.script.pop(0)
        if behavior == '429':
            self.send_response(429)
            self.send_header('retry-after', '0')
            self.end_headers()
            self.wfile.write(b'slow down')
            return
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        if behavior == 'hang':
            server.release.wait(5)
            return
        # 连接在两个事件之间断开，没有 finish_reason 也没有 [DONE]：工具参数只收到一半
        body = {'tool_call': TOOL_CALL, 'cut_before_text': FIRST_TOOL_CHUNK, 'cut_after_text': TEXT}[behavior]
        # 每 5 字节发一次：汉字、JSON、空行都会被切断
        for i in range(0, len(body), 5):
            self.wfile.write(body[i:i + 5])
            self.wfile.flush()
            time.sleep(0.001)


class OpenAICompatibleTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), FakeProvider)
        self.server.daemon_threads = True
        self.server.bodies, self.server.script, self.server.release = [], [], threading.Event()
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.sleeps = []

    def tearDown(self):
        self.server.release.set()
        self.server.shutdown()
        self.server.server_close()

    def model(self, **kwargs):
        async def fake_sleep(seconds):
            self.sleeps.append(seconds)

        base = f'http://127.0.0.1:{self.server.server_address[1]}/v1'
        return OpenAICompatibleModel(base, 'sk-test', 'test-model', sleep=fake_sleep, **kwargs)

    def request(self, deltas=None):
        return ModelRequest(messages=[Message('user', '出差住宿？')], tools=[{'name': 'search_knowledge', 'description': '', 'parameters': {}}],
                            on_text=deltas.append if deltas is not None else None)

    async def test_retries_429_and_assembles_tool_call_from_split_chunks(self):
        self.server.script[:] = ['429', 'tool_call']
        response = await self.model().complete(self.request())
        self.assertEqual(len(self.server.bodies), 2)
        self.assertEqual(self.sleeps, [0])  # 遵守 Retry-After: 0
        [call] = response.message.tool_calls
        self.assertEqual((call.id, call.name, json.loads(call.arguments)), ('call_1', 'search_knowledge', {'query': '差旅'}))
        self.assertEqual((response.usage.input_tokens, response.usage.output_tokens, response.finish_reason), (120, 9, 'tool_calls'))
        body = self.server.bodies[0]
        self.assertEqual(body['tools'][0]['type'], 'function')
        self.assertTrue(body['stream'])

    async def test_interrupted_stream_retries_only_before_text_was_emitted(self):
        self.server.script[:] = ['cut_before_text', 'tool_call']
        await self.model().complete(self.request())
        self.assertEqual(len(self.server.bodies), 2)

        self.server.bodies.clear()
        self.server.script[:] = ['cut_after_text', 'tool_call']
        deltas = []
        with self.assertRaises(ModelError) as caught:
            await self.model().complete(self.request(deltas))
        self.assertEqual((caught.exception.status, deltas, len(self.server.bodies)), (502, ['你好'], 1))

    async def test_cancel_and_timeout_interrupt_a_hanging_stream(self):
        self.server.script[:] = ['hang']
        task = asyncio.create_task(self.model().complete(self.request()))
        await asyncio.sleep(0.2)
        started = time.monotonic()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(self.sleeps, [])  # 用户取消不重试

        self.server.script[:] = ['hang']
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            await self.model(timeout_s=0.3, max_retries=0).complete(self.request())
        self.assertLess(time.monotonic() - started, 2)
