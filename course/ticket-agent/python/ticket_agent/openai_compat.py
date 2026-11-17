from __future__ import annotations

import asyncio
import http.client
import json
import random
import socket
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlsplit

from .sse import read_sse
from .types import Message, ModelRequest, ModelResponse, ToolCall, Usage, dumps

# 对应 src/llm/openai.ts：兼容 Chat Completions 协议的流式适配器（DeepSeek、通义千问、OpenAI 等）。
# 标准库没有异步 HTTP 客户端，这里用 http.client 在线程里做阻塞 IO，事件循环只负责等待。


class ModelError(Exception):
    def __init__(self, message: str, status: int, retryable: bool, retry_after: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.retryable = retryable
        self.retry_after = retry_after


# 可以重试的网络错误。asyncio.CancelledError 继承 BaseException，不在其中：用户取消永远不重试
NETWORK_ERRORS = (OSError, http.client.HTTPException, ValueError)


class OpenAICompatibleModel:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        timeout_s: float = 60,
        max_retries: int = 2,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.name = model
        self._url = urlsplit(base_url.rstrip('/'))
        self._api_key = api_key
        self._timeout_s = timeout_s
        self._max_retries = max_retries
        self._sleep = sleep

    async def complete(self, request: ModelRequest) -> ModelResponse:
        payload: dict[str, Any] = {
            'model': self.name,
            'messages': [_to_wire(m) for m in request.messages],
            'stream': True,
            'stream_options': {'include_usage': True},
        }
        if request.tools:
            payload['tools'] = [{'type': 'function', 'function': tool} for tool in request.tools]
        if request.max_output_tokens is not None:
            payload['max_tokens'] = request.max_output_tokens
        body = dumps(payload)

        attempt = 0
        while True:
            emitted = False

            def on_text(delta: str) -> None:
                nonlocal emitted
                emitted = True
                if request.on_text:
                    request.on_text(delta)

            try:
                # 整个请求（连接 + 读完流）的总超时。到时抛 TimeoutError（可重试），和用户取消（CancelledError）区分开
                async with asyncio.timeout(self._timeout_s):
                    return await self._once(body, on_text)
            except ModelError as error:
                # 已经向用户输出了文字就不能重试，否则内容会重复
                if not error.retryable or emitted or attempt >= self._max_retries:
                    raise
                delay = backoff_s(attempt, error.retry_after)
            except NETWORK_ERRORS:
                if emitted or attempt >= self._max_retries:
                    raise
                delay = backoff_s(attempt)
            await self._sleep(delay)
            attempt += 1

    async def _once(self, body: str, on_text: Callable[[str], None]) -> ModelResponse:
        conn_class = http.client.HTTPSConnection if self._url.scheme == 'https' else http.client.HTTPConnection
        conn = conn_class(self._url.netloc, timeout=self._timeout_s)
        try:
            response = await asyncio.to_thread(self._send, conn, body)
            if 200 <= response.status < 300:
                return await read_stream(_chunks(response), len(body), on_text)
            text = (await asyncio.to_thread(response.read)).decode('utf-8', 'replace')
            retryable = response.status == 429 or response.status >= 500
            raise ModelError(f'模型服务返回 {response.status}: {text[:300]}', response.status, retryable, response.getheader('retry-after'))
        finally:
            _abort(conn)

    def _send(self, conn: http.client.HTTPConnection, body: str) -> http.client.HTTPResponse:
        conn.request('POST', f'{self._url.path}/chat/completions', body.encode('utf-8'), {
            'content-type': 'application/json',
            'authorization': f'Bearer {self._api_key}',
        })
        return conn.getresponse()


async def _chunks(response: http.client.HTTPResponse) -> AsyncIterator[bytes]:
    while True:
        # read1 收到多少就返回多少；read(n) 会等凑满 n 字节，流式输出就变成了“攒一批再吐”
        chunk = await asyncio.to_thread(response.read1, 65536)
        if not chunk:
            return
        yield chunk


def _abort(conn: http.client.HTTPConnection) -> None:
    """取消或超时后，后台线程可能还卡在 recv 上；关闭 socket 让它立刻返回，不留下僵尸线程和连接。"""
    if conn.sock is not None:
        try:
            conn.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    conn.close()


async def read_stream(chunks: AsyncIterator[bytes], input_chars: int, on_text: Callable[[str], None]) -> ModelResponse:
    content = ''
    finish_reason = 'unknown'
    usage: Usage | None = None
    done = False
    calls: dict[int, dict[str, str]] = {}

    async for data in read_sse(chunks):
        if data == '[DONE]':
            done = True
            break
        chunk = json.loads(data)
        if chunk.get('usage'):
            usage = Usage(chunk['usage'].get('prompt_tokens') or 0, chunk['usage'].get('completion_tokens') or 0)
        choices = chunk.get('choices') or []
        if not choices:
            continue
        choice = choices[0]
        delta = choice.get('delta') or {}
        if delta.get('content'):
            content += delta['content']
            on_text(delta['content'])
        # 工具调用的参数也是分块到达的，按 index 拼起来，全部收完才能解析
        for part in delta.get('tool_calls') or []:
            call = calls.setdefault(part['index'], {'id': '', 'name': '', 'arguments': ''})
            function = part.get('function') or {}
            if part.get('id'):
                call['id'] = part['id']
            if function.get('name') and not call['name']:
                call['name'] = function['name']
            if function.get('arguments'):
                call['arguments'] += function['arguments']
        if choice.get('finish_reason'):
            finish_reason = choice['finish_reason']

    # 连接中途断开时，收到的工具参数可能只有一半。没有结束标记的响应一律视为失败
    if not done and finish_reason == 'unknown':
        raise ModelError('模型响应流意外中断', 502, True)

    tool_calls = tuple(ToolCall(**calls[index]) for index in sorted(calls))
    output_chars = len(content) + sum(len(call.arguments) for call in tool_calls)
    return ModelResponse(
        message=Message('assistant', content, tool_calls),
        # 服务商没给用量时宁多勿少地估算，保证 token 预算仍然有效
        usage=usage or Usage(input_chars, output_chars * 2, estimated=True),
        finish_reason=finish_reason,
    )


def _to_wire(message: Message) -> dict[str, Any]:
    if message.role == 'assistant':
        wire: dict[str, Any] = {'role': 'assistant', 'content': message.content or None}
        if message.tool_calls:
            wire['tool_calls'] = [
                {'id': c.id, 'type': 'function', 'function': {'name': c.name, 'arguments': c.arguments}} for c in message.tool_calls
            ]
        return wire
    if message.role == 'tool':
        return {'role': 'tool', 'tool_call_id': message.tool_call_id, 'content': message.content}
    return {'role': message.role, 'content': message.content}


def backoff_s(attempt: int, retry_after: str | None = None) -> float:
    """Retry-After 可能是秒数，也可能是 HTTP 日期；最长等 30 秒。"""
    if retry_after:
        try:
            return min(max(float(retry_after), 0), 30)
        except ValueError:
            pass
        try:
            return min(max(parsedate_to_datetime(retry_after).timestamp() - time.time(), 0), 30)
        except (TypeError, ValueError):
            pass
    return 0.5 * 2 ** attempt + random.random() * 0.2
