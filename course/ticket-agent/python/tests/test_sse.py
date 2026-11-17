import json
import unittest

from ticket_agent.sse import SSEParser, read_sse


def split_every(data: bytes, size: int) -> list[bytes]:
    return [data[i:i + size] for i in range(0, len(data), size)]


class SSEParserTest(unittest.TestCase):
    def test_reassembles_events_split_inside_multibyte_chars_and_crlf(self):
        payload = json.dumps({'text': '差旅住宿'}, ensure_ascii=False)
        stream = f'data: {payload}\r\n\r\n: 心跳注释\r\n\r\nevent: x\r\ndata: [DONE]\r\n\r\n'.encode('utf-8')
        # 每块 1 字节：每个汉字（3 字节）和每个 \r\n 都会被切断
        parser = SSEParser()
        events = [data for chunk in split_every(stream, 1) for data in parser.feed(chunk)] + parser.close()
        self.assertEqual(events, [payload, '[DONE]'])

    def test_joins_multiline_data_and_flushes_last_event_without_blank_line(self):
        parser = SSEParser()
        self.assertEqual(parser.feed(b'data: a\ndata:b\n\ndata: tail'), ['a\nb'])
        self.assertEqual(parser.close(), ['tail'])


class ReadSSETest(unittest.IsolatedAsyncioTestCase):
    async def test_async_generator_over_chunks(self):
        async def chunks():
            for part in (b'data: {"a"', b':1}\n', b'\ndata: [DONE]\n\n'):
                yield part

        self.assertEqual([data async for data in read_sse(chunks())], ['{"a":1}', '[DONE]'])
