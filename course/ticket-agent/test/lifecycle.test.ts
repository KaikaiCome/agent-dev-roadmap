import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { findUser } from '../src/data/seed.ts';
import { createMockModel } from '../src/llm/mock.ts';
import type { ChatModel } from '../src/llm/types.ts';
import { createApp, type AppOptions } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { createTools } from '../src/tools/index.ts';

const ORIGIN = 'http://localhost:5173';

// 问题里带“慢”字的 run 会一直卡在模型调用上，直到被中断，用来模拟执行中的任务
const mock = createMockModel();
const slowModel: ChatModel = {
  name: 'slow',
  complete(request) {
    const question = request.messages.find((m) => m.role === 'user')?.content ?? '';
    if (!question.includes('慢')) return mock.complete(request);
    return new Promise((_, reject) => request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true }));
  },
};

async function startApp(extra: Partial<AppOptions> = {}) {
  const store = new Store(':memory:');
  const app = createApp({ store, model: slowModel, tools: createTools(store), allowedOrigin: ORIGIN, ...extra });
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, cookie = '') => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie }, body: JSON.stringify(body),
  });
  return { store, app, base, post };
}

test('批准后恢复执行也受并发上限约束；优雅退出不会被打开的事件流和执行中的 run 卡住', async () => {
  const { store, app, base, post } = await startApp({ maxActiveRunsPerUser: 1, shutdownTimeoutMs: 2000 });
  const cookie = (await post('/api/login', { userId: 'alice' })).headers.get('set-cookie')!.split(';')[0];

  const { runId: ticketRun } = await (await post('/api/runs', { question: 'VPN 连不上，帮我提交 IT 工单' }, cookie)).json() as { runId: string };
  while (store.getRun(ticketRun)!.status !== 'waiting_approval') await new Promise((r) => setTimeout(r, 5));
  const request = store.events(ticketRun).find((e) => e.type === 'approval_requested')!;
  const callId = request.type === 'approval_requested' ? request.data.callId : '';

  const { runId: slowRun } = await (await post('/api/runs', { question: '慢慢查一下' }, cookie)).json() as { runId: string };
  assert.equal((await post(`/api/runs/${ticketRun}/approvals`, { callId, approved: true }, cookie)).status, 429);

  // 打开一个不会自然结束的事件流（run 在等审批）
  const stream = await fetch(`${base}/api/runs/${ticketRun}/events`, { headers: { cookie } });
  const reading = stream.text();

  const started = Date.now();
  await app.shutdown();
  assert.ok(Date.now() - started < 1500, '应在超时之前完成退出');
  await reading;
  // 服务重启引起的中断保持 running，下次启动由 recover() 继续
  assert.equal(store.getRun(slowRun)!.status, 'running');
  store.close();
});

test('关闭演示登录后，无法通过选用户名登录', async () => {
  const { store, app, base, post } = await startApp({ demoLogin: false });
  try {
    assert.equal((await post('/api/login', { userId: 'alice' })).status, 401);
    assert.equal((await fetch(base + '/api/users')).status, 401);
  } finally {
    await app.shutdown();
    store.close();
  }
});

test('生产环境默认拒绝演示登录，必须显式开启', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /SSO/);
  assert.equal(loadConfig({ NODE_ENV: 'production', DEMO_LOGIN: 'true' }).demoLogin, true);
  assert.equal(loadConfig({}).demoLogin, true);
  assert.equal(loadConfig({ DEMO_LOGIN: 'false' }).demoLogin, false);
});

test('一个事件订阅者抛错，不影响写入和其他订阅者', (t) => {
  t.mock.method(console, 'error', () => {});
  const store = new Store(':memory:');
  const received: number[] = [];
  store.onEvent(() => { throw new Error('坏掉的连接'); });
  store.onEvent((event) => received.push(event.seq));
  const run = store.createRun(findUser('alice')!, '你好');
  store.append(run.id, 'assistant_message', { content: '好', toolCalls: [] });
  assert.deepEqual(received, [1, 2]);
  assert.equal(store.events(run.id).length, 2);
  store.close();
});
