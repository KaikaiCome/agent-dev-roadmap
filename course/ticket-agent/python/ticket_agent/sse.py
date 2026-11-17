from __future__ import annotations

import codecs
from collections.abc import AsyncIterable, AsyncIterator

# 对应 src/llm/sse.ts。网络每次送来的一块数据可能只有半个汉字、半行 JSON，
# 所以先缓存，等到空行（一个完整事件的结尾）再交出 data。


class SSEParser:
    """增量解析器：feed 收到的字节，返回已完整的事件 data。与 IO 无关，同步、异步代码都能用。"""

    def __init__(self) -> None:
        # 增量解码器会把被切断的多字节汉字留到下一块再解码；直接 chunk.decode() 会抛 UnicodeDecodeError
        self._decoder = codecs.getincrementaldecoder('utf-8')()
        self._buffer = ''

    def feed(self, chunk: bytes) -> list[str]:
        self._buffer += self._decoder.decode(chunk)
        # 在累积的缓冲区上替换，\r 和 \n 被切在两块里时也能正确处理
        self._buffer = self._buffer.replace('\r\n', '\n')
        events: list[str] = []
        while (end := self._buffer.find('\n\n')) >= 0:
            data = _extract_data(self._buffer[:end])
            self._buffer = self._buffer[end + 2:]
            if data is not None:
                events.append(data)
        return events

    def close(self) -> list[str]:
        self._buffer += self._decoder.decode(b'', final=True)
        rest = _extract_data(self._buffer.replace('\r\n', '\n').strip())
        self._buffer = ''
        return [rest] if rest is not None else []


async def read_sse(chunks: AsyncIterable[bytes]) -> AsyncIterator[str]:
    parser = SSEParser()
    async for chunk in chunks:
        for data in parser.feed(chunk):
            yield data
    for data in parser.close():
        yield data


def _extract_data(raw_event: str) -> str | None:
    lines = [line[5:].removeprefix(' ') for line in raw_event.split('\n') if line.startswith('data:')]
    return '\n'.join(lines) if lines else None
