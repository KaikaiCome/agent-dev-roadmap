import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { AgentEvent } from '../src/events.ts';
import { createMockModel } from '../src/llm/mock.ts';
import { createApp } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { createTools } from '../src/tools/index.ts';

const ORIGIN = 'http://localhost:5173';
const store = new Store(':memory:');
const app = createApp({ store, model: createMockModel(), tools: createTools(store), allowedOrigin: ORIGIN });
let base = '';

before(async () => {
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => {
  await app.shutdown();
  store.close();
});

async function login(userId: string) {
  const res = await post('/api/login', { userId });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie')!.split(';')[0];
}

function post(path: string, body: unknown, cookie = '', headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie, ...headers },
    body: JSON.stringify(body),
  });
}

/** 读取 SSE，直到 until 返回 true 或服务端关闭连接 */
async function readEvents(path: string, cookie: string, until: (events: AgentEvent[]) => boolean = () => false, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const res = await fetch(base + path, { headers: { cookie, ...headers }, signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const events: AgentEvent[] = [];
  const deltas: string[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of res.body!) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const type = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (type === 'agent') events.push(JSON.parse(data!));
        if (type === 'delta') deltas.push(JSON.parse(data!).text);
      }
      if (until(events)) break;
    }
  } finally {
    controller.abort();
  }
  return { events, deltas };
}

test('未登录返回 401，跨站来源返回 403', async () => {
  assert.equal((await fetch(base + '/api/me')).status, 401);
  const res = await post('/api/login', { userId: 'alice' }, '', { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('提问 → SSE 实时收到事件和文字增量，结束后自动关闭', async () => {
  const cookie = await login('alice');
  const res = await post('/api/runs', { question: '出差住宿每晚能报销多少钱？' }, cookie);
  assert.equal(res.status, 201);
  const { runId } = (await res.json()) as { runId: string };
  const { events, deltas } = await readEvents(`/api/runs/${runId}/events`, cookie);

  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), 'seq 连续且不重复');
  assert.equal(events.at(-1)?.type, 'run_finished');
  assert.match(events.findLast((e) => e.type === 'assistant_message')?.data.content as string, /acme-travel@v2/);
  assert.ok(deltas.length > 0 || events.length > 0);

  // 断线重连：带上 Last-Event-ID 只会收到之后的事件
  const resumed = await readEvents(`/api/runs/${runId}/events`, cookie, undefined, { 'last-event-id': '3' });
  assert.equal(resumed.events[0].seq, 4);
});

test('别人的 run 返回 404，不泄露存在性', async () => {
  const alice = await login('alice');
  const bob = await login('bob');
  const { runId } = (await (await post('/api/runs', { question: '你好' }, alice)).json()) as { runId: string };
  assert.equal((await fetch(`${base}/api/runs/${runId}`, { headers: { cookie: bob } })).status, 404);
  assert.equal((await post(`/api/runs/${runId}/cancel`, {}, bob)).status, 404);
});

test('通过 HTTP 完成审批流程', async () => {
  const cookie = await login('alice');
  const { runId } = (await (await post('/api/runs', { question: 'VPN 连不上，帮我提交 IT 工单' }, cookie)).json()) as { runId: string };
  const first = await readEvents(`/api/runs/${runId}/events`, cookie, (events) => events.some((e) => e.type === 'approval_requested'));
  const request = first.events.find((e) => e.type === 'approval_requested')!;
  const callId = request.type === 'approval_requested' ? request.data.callId : '';

  assert.equal((await post(`/api/runs/${runId}/approvals`, { callId: 'nope', approved: true }, cookie)).status, 404);
  assert.equal((await post(`/api/runs/${runId}/approvals`, { callId, approved: true }, cookie)).status, 200);
  assert.equal((await post(`/api/runs/${runId}/approvals`, { callId, approved: true }, cookie)).status, 409);

  const rest = await readEvents(`/api/runs/${runId}/events?after=${request.seq}`, cookie);
  const finished = rest.events.at(-1);
  assert.equal(finished?.type === 'run_finished' && finished.data.status, 'completed');
  assert.equal(store.tickets('acme').length, 1);
});

test('请求体校验：非 JSON 返回 415，超大返回 413', async () => {
  const cookie = await login('alice');
  const res = await fetch(base + '/api/runs', { method: 'POST', headers: { 'content-type': 'text/plain', cookie }, body: 'hi' });
  assert.equal(res.status, 415);
  assert.equal((await post('/api/runs', { question: 'x'.repeat(20_000) }, cookie)).status, 413);
});
