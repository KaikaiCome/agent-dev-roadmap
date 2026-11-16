import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Store } from '../../src/store.ts';
import { createMcpHttpApp, DEMO_TOKENS, demoTokenVerifier } from '../http.ts';

const store = new Store(':memory:');
const app = createMcpHttpApp({ store, verifier: demoTokenVerifier(DEMO_TOKENS) });
after(() => app.close());

type Answer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean> };

/** 进程内连接：客户端的 fetch 直接调用 app.fetch，不需要真的监听端口 */
async function connect(token: string, options: { era?: 'modern' | 'legacy'; answer?: () => Answer } = {}) {
  const client = new Client(
    { name: 'test-host', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      ...(options.era === 'legacy' ? {} : { versionNegotiation: { mode: 'auto' as const } }),
    },
  );
  const asked: string[] = [];
  client.setRequestHandler('elicitation/create', async (request) => {
    asked.push(request.params.message);
    return options.answer?.() ?? { action: 'cancel' };
  });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      // 真实 HTTP 请求总带 Host 头；进程内构造的 Request 没有，需要补上
      headers.set('host', new URL(url).host);
      return app.fetch(new Request(url, { ...init, headers }));
    },
  });
  await client.connect(transport);
  return { client, asked };
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as Array<{ type: string; text?: string }>).map((block) => block.text ?? '').join('\n');

test('工具列表顺序固定，读写工具带有正确的注解', async () => {
  const { client } = await connect('demo-alice');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['search_policy', 'prepare_ticket', 'submit_ticket']);
  assert.equal(tools[0].annotations?.readOnlyHint, true);
  assert.equal(tools[2].annotations?.readOnlyHint, false);
  assert.ok(tools[0].outputSchema, '结构化输出要声明 outputSchema');
  await client.close();
});

test('检索按 token 对应的员工过滤：跨租户、跨角色都看不到', async () => {
  const alice = (await connect('demo-alice')).client;
  const bob = (await connect('demo-bob')).client;
  const carol = (await connect('demo-carol')).client;

  const forAlice = await alice.callTool({ name: 'search_policy', arguments: { query: '差旅住宿报销上限' } });
  assert.match(text(forAlice), /acme-travel@v2/);
  assert.doesNotMatch(text(forAlice), /globex/);
  assert.match(text(await bob.callTool({ name: 'search_policy', arguments: { query: '差旅住宿报销上限' } })), /globex-travel@v1/);

  const budget = { name: 'search_policy', arguments: { query: 'Q4 预算冻结' } };
  assert.match(text(await carol.callTool(budget)), /acme-budget/);
  assert.doesNotMatch(text(await alice.callTool(budget)), /acme-budget/);
  await Promise.all([alice.close(), bob.close(), carol.close()]);
});

test('参数不合法时返回 isError 结果，模型可以读懂并改正', async () => {
  const { client } = await connect('demo-alice');
  const result = await client.callTool({ name: 'search_policy', arguments: { query: '' } });
  assert.equal(result.isError, true);
  await client.close();
});

test('提交工单先请员工确认：拒绝不创建，同意只创建一张', async () => {
  let answer: Answer = { action: 'decline' };
  const { client, asked } = await connect('demo-alice', { answer: () => answer });
  const prepared = await client.callTool({ name: 'prepare_ticket', arguments: { title: 'VPN 无法连接', description: '重启后仍失败' } });
  const { draftId } = prepared.structuredContent as { draftId: string };

  const declined = await client.callTool({ name: 'submit_ticket', arguments: { draftId } });
  assert.deepEqual(declined.structuredContent, { submitted: false });
  assert.match(asked[0], /VPN 无法连接/, '确认框里展示的是草稿内容');
  assert.equal(store.tickets('acme').length, 0);

  answer = { action: 'accept', content: { confirm: true } };
  const first = (await client.callTool({ name: 'submit_ticket', arguments: { draftId } })).structuredContent as { ticketId: string; duplicate: boolean };
  const again = (await client.callTool({ name: 'submit_ticket', arguments: { draftId } })).structuredContent;
  assert.equal(first.duplicate, false);
  assert.deepEqual(again, { submitted: true, ticketId: first.ticketId, duplicate: true });
  assert.equal(store.tickets('acme').length, 1);
  await client.close();
});

test('不能提交别人的草稿，也不会弹出确认框；越权尝试留有审计记录', async () => {
  const alice = (await connect('demo-alice')).client;
  const prepared = await alice.callTool({ name: 'prepare_ticket', arguments: { title: '申请显示器', description: '需要第二块屏幕' } });
  const { draftId } = prepared.structuredContent as { draftId: string };

  const { client: bob, asked } = await connect('demo-bob', { answer: () => ({ action: 'accept', content: { confirm: true } }) });
  const result = await bob.callTool({ name: 'submit_ticket', arguments: { draftId } });
  assert.equal(result.isError, true);
  assert.match(text(result), /DRAFT_NOT_FOUND/);
  assert.equal(asked.length, 0);
  assert.equal(store.tickets('globex').length, 0);

  const denied = store.runsWithStatus('failed').filter((run) => run.userId === 'bob');
  assert.equal(denied.length, 1);
  const finished = store.events(denied[0].id).find((e) => e.type === 'run_finished');
  assert.equal(finished?.type === 'run_finished' ? finished.data.reason : undefined, 'DRAFT_NOT_FOUND');
  await Promise.all([alice.close(), bob.close()]);
});

test('2025 版客户端走无状态 HTTP 收不到确认请求：写操作失败关闭，不会绕过确认', async () => {
  const { client, asked } = await connect('demo-carol', { era: 'legacy', answer: () => ({ action: 'accept', content: { confirm: true } }) });
  const prepared = await client.callTool({ name: 'prepare_ticket', arguments: { title: '报销系统打不开', description: '提示 502' } });
  const { draftId } = prepared.structuredContent as { draftId: string };
  const submitted = await client.callTool({ name: 'submit_ticket', arguments: { draftId } });
  assert.equal(submitted.isError, true);
  assert.match(text(submitted), /elicitation/);
  assert.equal(asked.length, 0);
  assert.equal(store.tickets('acme').filter((t) => t.draftId === draftId).length, 0);
  await client.close();
});

test('每次工具调用都记录为已结束的审计 run，重启时不会被当成未完成任务恢复', () => {
  assert.equal(store.runsWithStatus('running').length, 0);
  const audits = store.runsWithStatus('completed');
  assert.ok(audits.length > 0);
  assert.ok(audits.every((run) => run.question.startsWith('[mcp] ')));
});

test('HTTP 入口：没有 token 返回 401 并带 WWW-Authenticate；伪造的 Host 被拒绝', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const post = (url: string, extra: Record<string, string> = {}) =>
    app.fetch(new Request(url, { method: 'POST', headers: { ...headers, host: new URL(url).host, ...extra }, body }));

  const noToken = await post('http://localhost/mcp');
  assert.equal(noToken.status, 401);
  assert.match(noToken.headers.get('www-authenticate') ?? '', /^Bearer/);
  assert.equal((await post('http://localhost/mcp', { authorization: 'Bearer stolen' })).status, 401);
  assert.equal((await post('http://evil.example/mcp', { authorization: 'Bearer demo-alice' })).status, 403);
});

test('stdio 入口：身份来自 MCP_USER；长连接上 2025 版客户端也能完成确认', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-stdio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spawnServer = async (era: 'modern' | 'legacy') => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, '..', 'stdio.ts')],
      env: { ...process.env, MCP_USER: 'bob', DATABASE_PATH: join(dir, 'agent.db') } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'test-host', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } }, ...(era === 'modern' ? { versionNegotiation: { mode: 'auto' as const } } : {}) },
    );
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { confirm: true } }));
    await client.connect(transport);
    return client;
  };

  const modern = await spawnServer('modern');
  try {
    assert.match(text(await modern.callTool({ name: 'search_policy', arguments: { query: '差旅住宿报销上限' } })), /globex-travel@v1/);
  } finally {
    await modern.close();
  }

  const legacy = await spawnServer('legacy');
  try {
    const prepared = await legacy.callTool({ name: 'prepare_ticket', arguments: { title: '门禁卡失效', description: '刷卡无反应' } });
    const { draftId } = prepared.structuredContent as { draftId: string };
    const submitted = await legacy.callTool({ name: 'submit_ticket', arguments: { draftId } });
    assert.equal((submitted.structuredContent as { submitted: boolean }).submitted, true);
  } finally {
    await legacy.close();
  }
});
