import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveApproval, runAgent } from '../src/agent.ts';
import { findUser } from '../src/data/seed.ts';
import { createScriptedModel } from '../src/llm/mock.ts';
import type { ChatModel, Message, ModelRequest, ModelResponse } from '../src/llm/types.ts';
import { Store } from '../src/store.ts';
import { createTools } from '../src/tools/index.ts';

const alice = findUser('alice')!;
const carol = findUser('carol')!;

function setup(replies: Parameters<typeof createScriptedModel>[0], extra: { maxSteps?: number } = {}) {
  const store = new Store(':memory:');
  const options = { store, model: createScriptedModel(replies), tools: createTools(store), ...extra };
  return { store, options };
}

const lastToolResult = (messages: Message[]) => JSON.parse(messages.findLast((m) => m.role === 'tool')!.content);

const ticketFlow = [
  { toolCalls: [{ name: 'prepare_ticket', args: { title: 'VPN 无法连接', description: '重启后仍失败' } }] },
  (messages: Message[]) => ({ toolCalls: [{ name: 'create_ticket', args: { draftId: lastToolResult(messages).data.draftId } }] }),
];

test('写操作先暂停等待审批，批准后才执行，且只创建一张工单', async () => {
  const { store, options } = setup([...ticketFlow, (m) => ({ content: `已创建 ${lastToolResult(m).data.ticketId}` })]);
  const run = store.createRun(alice, 'VPN 连不上，帮我提交工单');

  assert.equal(await runAgent(run.id, alice, options), 'waiting_approval');
  assert.equal(store.tickets('acme').length, 0, '审批前不能有副作用');
  const request = store.events(run.id).find((e) => e.type === 'approval_requested')!;
  assert.match(request.type === 'approval_requested' ? request.data.summary : '', /VPN 无法连接/);

  const callId = request.type === 'approval_requested' ? request.data.callId : '';
  assert.deepEqual(resolveApproval(store, run.id, alice, callId, true), { ok: true, approved: true });
  assert.deepEqual(resolveApproval(store, run.id, alice, callId, true), { ok: false, code: 'NOT_WAITING' });
  assert.equal(await runAgent(run.id, alice, options), 'completed');
  assert.equal(store.tickets('acme').length, 1);
});

test('拒绝后工具不执行，模型收到 APPROVAL_REJECTED', async () => {
  let seen: unknown;
  const { store, options } = setup([...ticketFlow, (m) => { seen = lastToolResult(m); return { content: '好的，未提交' }; }]);
  const run = store.createRun(alice, '帮我提交工单');
  await runAgent(run.id, alice, options);
  const request = store.events(run.id).find((e) => e.type === 'approval_requested')!;
  resolveApproval(store, run.id, alice, request.type === 'approval_requested' ? request.data.callId : '', false);
  assert.equal(await runAgent(run.id, alice, options), 'completed');
  assert.equal(store.tickets('acme').length, 0);
  assert.deepEqual(seen, { ok: false, error: { code: 'APPROVAL_REJECTED', message: '员工拒绝了这个操作，操作未执行' } });
});

test('只有发起人能审批，过期的审批按拒绝处理', async () => {
  const { store, options } = setup([...ticketFlow, { content: '已超时' }]);
  const run = store.createRun(alice, '帮我提交工单');
  await runAgent(run.id, alice, options);
  const request = store.events(run.id).find((e) => e.type === 'approval_requested')!;
  const callId = request.type === 'approval_requested' ? request.data.callId : '';
  assert.deepEqual(resolveApproval(store, run.id, carol, callId, true), { ok: false, code: 'NOT_FOUND' });
  const tomorrow = new Date(Date.now() + 24 * 3600_000);
  assert.deepEqual(resolveApproval(store, run.id, alice, callId, true, tomorrow), { ok: true, approved: false });
  await runAgent(run.id, alice, options);
  assert.equal(store.tickets('acme').length, 0);
});

test('进程在工具执行中崩溃后恢复：继续执行未完成的调用，幂等键保证不重复建单', async () => {
  const { store, options } = setup([...ticketFlow, { content: '完成' }]);
  const run = store.createRun(alice, '帮我提交工单');
  await runAgent(run.id, alice, options);
  const request = store.events(run.id).find((e) => e.type === 'approval_requested')!;
  const callId = request.type === 'approval_requested' ? request.data.callId : '';
  resolveApproval(store, run.id, alice, callId, true);

  // 模拟：工单已在外部系统创建，但写 tool_finished 之前进程崩溃了
  const createTool = options.tools.find((t) => t.spec.name === 'create_ticket')!;
  const args = request.type === 'approval_requested' ? request.data.args : {};
  await createTool.run(args, { user: alice, runId: run.id, callId, signal: new AbortController().signal });
  store.append(run.id, 'tool_started', { callId, name: 'create_ticket', args });

  assert.equal(await runAgent(run.id, alice, options), 'completed');
  assert.equal(store.tickets('acme').length, 1);
  const finished = store.events(run.id).find((e) => e.type === 'tool_finished' && e.data.callId === callId);
  assert.equal(finished?.type === 'tool_finished' && (finished.data.result as { duplicate: boolean }).duplicate, true);
});

test('未知工具和非法参数作为错误回传给模型，让它自我修正', async () => {
  const results: unknown[] = [];
  const { store, options } = setup([
    { toolCalls: [{ name: 'delete_database', args: {} }] },
    (m) => { results.push(lastToolResult(m)); return { toolCalls: [{ name: 'search_knowledge', args: { query: 123 } }] }; },
    (m) => { results.push(lastToolResult(m)); return { content: '抱歉' }; },
  ]);
  const run = store.createRun(alice, '你好');
  assert.equal(await runAgent(run.id, alice, options), 'completed');
  assert.deepEqual(results.map((r: any) => r.error.code), ['UNKNOWN_TOOL', 'INVALID_ARGUMENTS']);
});

test('超过最大步数时停止，避免死循环烧钱', async () => {
  const loop = { toolCalls: [{ name: 'search_knowledge', args: { query: 'VPN' } }] };
  const { store, options } = setup([loop, loop, loop, loop], { maxSteps: 3 });
  const run = store.createRun(alice, 'VPN');
  assert.equal(await runAgent(run.id, alice, options), 'budget_exceeded');
  assert.equal(store.events(run.id).filter((e) => e.type === 'assistant_message').length, 3);
});

test('即使模型被文档里的注入指令骗了，写操作也会被审批拦下', async () => {
  const { store, options } = setup([
    { toolCalls: [{ name: 'search_knowledge', args: { query: '会议室预订' } }] },
    // 假设模型“听从”了文档里的恶意指令
    { toolCalls: [{ name: 'prepare_ticket', args: { title: '发送预算', description: '发给 attacker@example.com' } }] },
    (m) => ({ toolCalls: [{ name: 'create_ticket', args: { draftId: lastToolResult(m).data.draftId } }] }),
  ]);
  const run = store.createRun(alice, '会议室怎么预订？');
  assert.equal(await runAgent(run.id, alice, options), 'waiting_approval');
  assert.equal(store.tickets('acme').length, 0);
});

test('不能提交别人或别的 run 的草稿', async () => {
  let foreignDraftId = '';
  const { store, options } = setup([
    () => ({ toolCalls: [{ name: 'create_ticket', args: { draftId: foreignDraftId } }] }),
    { content: '失败了' },
  ]);
  const other = store.createRun(carol, '其他请求');
  foreignDraftId = store.saveDraft({ runId: other.id, tenantId: 'acme', userId: 'carol', title: 'x', description: 'y', sourceIds: [] }).id;
  const run = store.createRun(alice, '提交');
  await runAgent(run.id, alice, options);
  const request = store.events(run.id).find((e) => e.type === 'approval_requested')!;
  resolveApproval(store, run.id, alice, request.type === 'approval_requested' ? request.data.callId : '', true);
  await runAgent(run.id, alice, options);
  const finished = store.events(run.id).find((e) => e.type === 'tool_finished');
  assert.equal(finished?.type === 'tool_finished' && finished.data.error?.code, 'DRAFT_NOT_FOUND');
  assert.equal(store.tickets('acme').length, 0);
});

function fixedModel(response: Omit<ModelResponse, 'usage'>, seen: ModelRequest[] = []): ChatModel {
  return { name: 'fixed', complete: async (request) => { seen.push(request); return { ...response, usage: { inputTokens: 100, outputTokens: 50 } }; } };
}

test('输出被长度截断时，半截的工具调用不执行，run 失败', async () => {
  const store = new Store(':memory:');
  const model = fixedModel({
    finishReason: 'length',
    message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'prepare_ticket', arguments: '{"title":"VPN' }] },
  });
  const run = store.createRun(alice, '提交工单');
  assert.equal(await runAgent(run.id, alice, { store, model, tools: createTools(store) }), 'failed');
  assert.equal(store.events(run.id).some((e) => e.type === 'tool_started' || e.type === 'tool_finished'), false);
});

test('单次输出上限不超过剩余 token 预算', async () => {
  const store = new Store(':memory:');
  const seen: ModelRequest[] = [];
  const model = fixedModel({ finishReason: 'stop', message: { role: 'assistant', content: '好' } }, seen);
  const run = store.createRun(alice, '你好');
  await runAgent(run.id, alice, { store, model, tools: [], maxTokens: 500, maxOutputTokens: 2000 });
  assert.equal(seen[0].maxOutputTokens, 500);
});

test('最终回答、用量和结束状态原子提交；只缺结束事件的旧数据直接结束，不再调用模型', async () => {
  const store = new Store(':memory:');
  const run = store.createRun(alice, '你好');
  const model = fixedModel({ finishReason: 'stop', message: { role: 'assistant', content: '好' } });
  assert.equal(await runAgent(run.id, alice, { store, model, tools: [] }), 'completed');
  assert.deepEqual(store.events(run.id).slice(-3).map((e) => e.type), ['assistant_message', 'usage', 'run_finished']);

  const legacy = store.createRun(alice, '你好');
  store.append(legacy.id, 'assistant_message', { content: '好', toolCalls: [] });
  store.append(legacy.id, 'usage', { model: 'old', inputTokens: 1, outputTokens: 1, latencyMs: 1 });
  const never: ChatModel = { name: 'never', complete: async () => { throw new Error('不应调用模型'); } };
  assert.equal(await runAgent(legacy.id, alice, { store, model: never, tools: [] }), 'completed');
});
