import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAICompatibleModel, ModelError } from '../src/llm/openai.ts';
import { readSSE } from '../src/llm/sse.ts';

const encoder = new TextEncoder();

async function* chunks(...parts: Array<string | Uint8Array>) {
  for (const part of parts) yield typeof part === 'string' ? encoder.encode(part) : part;
}

test('readSSE 能处理被任意切开的分块、CRLF 和被切断的中文字符', async () => {
  const bytes = encoder.encode('data: 你好\r\n\r\ndata: {"a":\ndata: 1}\n\n');
  // 在“你”的 3 个字节中间切开
  const parts = [bytes.slice(0, 7), bytes.slice(7, 20), bytes.slice(20)];
  const events: string[] = [];
  for await (const data of readSSE(chunks(...parts))) events.push(data);
  assert.deepEqual(events, ['你好', '{"a":\n1}']);
});

function sse(...payloads: unknown[]) {
  const text = payloads.map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('适配器拼接流式文本和分块到达的工具调用参数，并读取用量', async () => {
  let sentBody: any;
  const model = createOpenAICompatibleModel({
    baseURL: 'https://llm.test', apiKey: 'k', model: 'm',
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(String(init?.body));
      return sse(
        { choices: [{ delta: { content: '先' } }] },
        { choices: [{ delta: { content: '查一下', tool_calls: [{ index: 0, id: 'c1', function: { name: 'search_knowledge', arguments: '{"que' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"VPN"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } },
        '[DONE]',
      );
    },
  });
  const deltas: string[] = [];
  const response = await model.complete({
    messages: [{ role: 'user', content: 'VPN 连不上' }],
    tools: [{ name: 'search_knowledge', description: 'd', parameters: {} }],
    onText: (text) => deltas.push(text),
  });
  assert.equal(sentBody.stream, true);
  assert.equal(sentBody.tools[0].function.name, 'search_knowledge');
  assert.deepEqual(deltas, ['先', '查一下']);
  assert.equal(response.message.content, '先查一下');
  assert.deepEqual(response.message.toolCalls, [{ id: 'c1', name: 'search_knowledge', arguments: '{"query":"VPN"}' }]);
  assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 5 });
  assert.equal(response.finishReason, 'tool_calls');
});

test('429 会按 Retry-After 重试，401 不重试并抛出 ModelError', async () => {
  const waits: number[] = [];
  let calls = 0;
  const retrying = createOpenAICompatibleModel({
    baseURL: 'https://llm.test', apiKey: 'k', model: 'm', sleep: async (ms) => { waits.push(ms); },
    fetchImpl: async () => (++calls === 1
      ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
      : sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]')),
  });
  const ok = await retrying.complete({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(ok.message.content, 'ok');
  assert.deepEqual(waits, [2000]);

  let unauthorizedCalls = 0;
  const unauthorized = createOpenAICompatibleModel({
    baseURL: 'https://llm.test', apiKey: 'bad', model: 'm', sleep: async () => {},
    fetchImpl: async () => { unauthorizedCalls++; return new Response('invalid api key', { status: 401 }); },
  });
  await assert.rejects(unauthorized.complete({ messages: [{ role: 'user', content: 'hi' }] }), (error: unknown) => {
    assert.ok(error instanceof ModelError);
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(unauthorizedCalls, 1);
});

test('用户取消时不重试', async () => {
  const controller = new AbortController();
  let calls = 0;
  const model = createOpenAICompatibleModel({
    baseURL: 'https://llm.test', apiKey: 'k', model: 'm', sleep: async () => {},
    fetchImpl: async () => { calls++; controller.abort(); throw new DOMException('aborted', 'AbortError'); },
  });
  await assert.rejects(model.complete({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }));
  assert.equal(calls, 1);
});

test('流在没有结束标记时中断：未输出文字则重试，已输出文字则报错，不执行半截工具调用', async () => {
  const cut = () => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'create_ticket', arguments: '{"dra' } }] } }] });
  let calls = 0;
  const retrying = createOpenAICompatibleModel({
    baseURL: 'https://llm.test', apiKey: 'k', model: 'm', sleep: async () => {},
    fetchImpl: async () => (++calls === 1 ? cut() : sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]')),
  });
  assert.equal((await retrying.complete({ messages: [{ role: 'user', content: 'hi' }] })).message.content, 'ok');
  assert.equal(calls, 2);

  let textCalls = 0;
  const emitted = createOpenAICompatibleModel({
    baseURL: 'https://llm.test', apiKey: 'k', model: 'm', sleep: async () => {},
    fetchImpl: async () => { textCalls++; return sse({ choices: [{ delta: { content: '一半' } }] }); },
  });
  await assert.rejects(emitted.complete({ messages: [{ role: 'user', content: 'hi' }], onText: () => {} }), /意外中断/);
  assert.equal(textCalls, 1, '已经推给用户的文字不能重试，否则会重复');
});

test('服务商不返回用量时按字符数估算，并标记 estimated', async () => {
  const model = createOpenAICompatibleModel({
    baseURL: 'https://llm.test', apiKey: 'k', model: 'm',
    fetchImpl: async () => sse({ choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }] }, '[DONE]'),
  });
  const { usage } = await model.complete({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(usage.estimated, true);
  assert.equal(usage.outputTokens, 4);
  assert.ok(usage.inputTokens > 0);
});
