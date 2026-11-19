import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findUser } from '../src/data/seed.ts';
import { createMockModel, createScriptedModel } from '../src/llm/mock.ts';
import type { ChatModel, Message } from '../src/llm/types.ts';
import { END, GraphRecursionError, InvalidUpdateError, MemoryGraphCheckpointer, START, StateGraph } from '../src/paradigms/graph.ts';
import { Harness, MemoryCheckpointer } from '../src/paradigms/harness.ts';
import { agentLoop, newLoopState } from '../src/paradigms/loop.ts';
import { createTicketGraph, type TicketState } from '../src/paradigms/ticket-graph.ts';
import { Store } from '../src/store.ts';
import { createTools } from '../src/tools/index.ts';
import type { Tool } from '../src/tools/types.ts';

const alice = findUser('alice')!;
const bob = findUser('bob')!;
const question = 'VPN 连不上，帮我提交工单';
const lastToolResult = (messages: Message[]) => JSON.parse(messages.findLast((m) => m.role === 'tool')!.content);

/** prepare → create → 用最后一个工具结果组织回答 */
const ticketScript = () => createScriptedModel([
  { toolCalls: [{ name: 'prepare_ticket', args: { title: 'VPN 无法连接', description: '重启后仍失败' } }] },
  (m) => ({ toolCalls: [{ name: 'create_ticket', args: { draftId: lastToolResult(m).data.draftId } }] }),
  (m) => ({ content: JSON.stringify(lastToolResult(m)) }),
]);

/** 永远用同样的参数调用检索、从不给出回答的模型，每次报 110 token */
function runaway() {
  const model = {
    name: 'runaway',
    calls: 0,
    async complete() {
      model.calls += 1;
      return {
        message: { role: 'assistant' as const, content: '', toolCalls: [{ id: `c${model.calls}`, name: 'search_knowledge', arguments: '{"query":"VPN"}' }] },
        usage: { inputTokens: 100, outputTokens: 10 },
        finishReason: 'tool_calls',
      };
    },
  };
  return model;
}

function harnessFor(store: Store, model: ChatModel, checkpointer = new MemoryCheckpointer(), policy = {}) {
  return new Harness({ model, tools: createTools(store), checkpointer, policy });
}

// ── Agent Loop vs Harness ─────────────────────────────────────────────

test('裸循环不知道审批：写工具被直接执行；同样的内核加上 harness 后先暂停', async () => {
  const store = new Store();
  const bare = store.createRun(alice, question);
  const outcome = await agentLoop(newLoopState('sys', question), { model: ticketScript(), tools: createTools(store), user: alice, runId: bare.id });
  assert.equal(outcome.status, 'completed');
  assert.equal(store.tickets('acme').length, 1, '没有人确认，工单已经建了');

  const guarded = store.createRun(alice, question);
  const record = await harnessFor(store, ticketScript()).start(guarded.id, alice, question);
  assert.equal(record.status, 'waiting_approval');
  assert.match(record.pending!.summary, /VPN 无法连接/);
  assert.equal(store.tickets('acme').length, 1, 'harness 下审批前没有副作用');
});

test('失控的模型：裸循环一直跑到保险丝熔断；harness 在第 3 次重复调用前停下，或在 token 预算用完时停下', async () => {
  const store = new Store();
  const bareModel = runaway();
  await assert.rejects(
    agentLoop(newLoopState('sys', 'VPN'), { model: bareModel, tools: createTools(store), user: alice, runId: 'r', fuse: 20 }),
    /保险丝熔断/,
  );
  assert.equal(bareModel.calls, 20);

  const repeated = runaway();
  const stopped = await harnessFor(store, repeated).start('r1', alice, 'VPN');
  assert.equal(stopped.status, 'stopped');
  assert.match(stopped.reason!, /重复了 3 次：search_knowledge/);
  assert.equal(repeated.calls, 3);

  const expensive = runaway();
  const broke = await harnessFor(store, expensive, new MemoryCheckpointer(), { maxRepeats: 99, maxTokens: 500 }).start('r2', alice, 'VPN');
  assert.match(broke.reason!, /token 预算 500（已用 550）/);
  assert.equal(expensive.calls, 5);
});

test('工具出错：裸循环整个 run 崩溃；harness 把错误包成结果交给模型，模型自己改正', async () => {
  const script = () => createScriptedModel([
    { toolCalls: [{ name: 'prepare_ticket', args: { title: '', description: 'x' } }] },
    (m) => ({ content: `收到错误 ${lastToolResult(m).error.code}，请补充标题` }),
  ]);
  const store = new Store();
  const run = store.createRun(alice, question);
  await assert.rejects(
    agentLoop(newLoopState('sys', question), { model: script(), tools: createTools(store), user: alice, runId: run.id }),
    /title 必须是非空字符串/,
  );
  const record = await harnessFor(store, script()).start(run.id, alice, question);
  assert.equal(record.status, 'completed');
  assert.equal(record.answer, '收到错误 INVALID_ARGUMENTS，请补充标题');
});

test('审批：检查点可序列化；换一个 Harness 实例（模拟重启）恢复；只有发起人能审批；重复 resume 不会重复执行', async () => {
  const store = new Store();
  const checkpointer = new MemoryCheckpointer();
  const model = ticketScript();
  const run = store.createRun(alice, question);
  const paused = await harnessFor(store, model, checkpointer).start(run.id, alice, question);
  assert.equal(checkpointer.load(run.id)!.status, 'waiting_approval');

  const restarted = harnessFor(store, model, checkpointer);
  assert.throws(() => restarted.decide(run.id, bob, paused.pending!.callId, true), /不存在/);
  restarted.decide(run.id, alice, paused.pending!.callId, true);
  const done = await restarted.resume(run.id, alice);
  assert.equal(done.status, 'completed');
  assert.equal(JSON.parse(done.answer!).data.duplicate, false);
  const again = await restarted.resume(run.id, alice);
  assert.equal(again.status, 'completed');
  assert.equal(again.state.steps, 3, '已结束的 run 不会再调用模型');
  assert.equal(store.tickets('acme').length, 1);
});

test('拒绝：模型收到 APPROVAL_REJECTED，不建单', async () => {
  const store = new Store();
  const harness = harnessFor(store, ticketScript());
  const run = store.createRun(alice, question);
  const paused = await harness.start(run.id, alice, question);
  harness.decide(run.id, alice, paused.pending!.callId, false);
  const done = await harness.resume(run.id, alice);
  assert.deepEqual(JSON.parse(done.answer!).error, { code: 'APPROVAL_REJECTED', message: '员工拒绝了这个操作，操作未执行' });
  assert.equal(store.tickets('acme').length, 0);
});

test('副作用之后、检查点之前崩溃：harness 从检查点恢复，工具重跑但幂等键挡住重复；裸循环只能从头再来，多出一张工单', async () => {
  const store = new Store();
  const checkpointer = new MemoryCheckpointer();
  const model = ticketScript();
  const run = store.createRun(alice, question);
  const paused = await harnessFor(store, model, checkpointer).start(run.id, alice, question);
  const harness = harnessFor(store, model, checkpointer);
  harness.decide(run.id, alice, paused.pending!.callId, true);
  checkpointer.crashBeforeSave = (record) => record.state.messages.at(-1)?.role === 'tool' && record.state.messages.at(-1)!.content.includes('ticketId');
  await assert.rejects(harness.resume(run.id, alice), /模拟崩溃/);
  assert.equal(store.tickets('acme').length, 1, '工单已经建了，但检查点里没有记录');

  checkpointer.crashBeforeSave = undefined;
  const recovered = await harnessFor(store, model, checkpointer).resume(run.id, alice);
  assert.equal(JSON.parse(recovered.answer!).data.duplicate, true, '恢复后 create_ticket 又执行了一次，拿到的是同一张工单');
  assert.equal(store.tickets('acme').length, 1);

  // 裸循环：状态只在内存里，进程死了就没了，只能重新发起，新的 runId 意味着新的幂等键
  const bareStore = new Store();
  const crashing = createTools(bareStore).map((tool): Tool => tool.spec.name !== 'create_ticket' ? tool : {
    ...tool,
    async run(args, context) {
      await tool.run(args, context);
      throw new Error('进程崩溃');
    },
  });
  const first = bareStore.createRun(alice, question);
  await assert.rejects(agentLoop(newLoopState('sys', question), { model: ticketScript(), tools: crashing, user: alice, runId: first.id }), /进程崩溃/);
  const retry = bareStore.createRun(alice, question);
  await agentLoop(newLoopState('sys', question), { model: ticketScript(), tools: createTools(bareStore), user: alice, runId: retry.id });
  assert.equal(bareStore.tickets('acme').length, 2);
});

// ── Graph 运行时 ──────────────────────────────────────────────────────

test('Graph：条件边可以形成环；走不出去的环触发递归上限', async () => {
  const counter = (router: (s: { n: number }) => string, recursionLimit?: number) => new StateGraph<{ n: number }>({ initial: () => ({ n: 0 }) })
    .addNode('inc', (s) => ({ n: s.n + 1 }))
    .addEdge(START, 'inc')
    .addConditionalEdges('inc', router, ['inc', END])
    .compile({ checkpointer: new MemoryGraphCheckpointer(), recursionLimit });

  const graph = counter((s) => (s.n < 3 ? 'inc' : END));
  const result = await graph.invoke({}, { threadId: 't', config: undefined });
  assert.deepEqual(result.state, { n: 3 });
  assert.deepEqual(graph.getHistory('t').map((c) => [c.step, c.next.join()]), [[0, 'inc'], [1, 'inc'], [2, 'inc'], [3, '']]);

  await assert.rejects(counter(() => 'inc', 10).invoke({}, { threadId: 't', config: undefined }), GraphRecursionError);
});

test('Graph：扇出的节点在同一步并发、读同一份快照，扇入的节点只运行一次；没有 reducer 的字段被同时写会报错', async () => {
  type S = { x: number; log: string[] };
  const build = (bWritesX: boolean) => new StateGraph<S>({ initial: () => ({ x: 0, log: [] }), reducers: { log: (a, b) => [...a, ...b] } })
    .addNode('a', (s, ctx) => ({ x: s.x + 1, log: [`${ctx.step}:a`] }))
    .addNode('b', (s, ctx) => ({ log: [`${ctx.step}:b saw x=${s.x}`], ...(bWritesX ? { x: 100 } : {}) }))
    .addNode('join', (_s, ctx) => ({ log: [`${ctx.step}:join`] }))
    .addEdge(START, 'a').addEdge(START, 'b')
    .addEdge('a', 'join').addEdge('b', 'join')
    .addEdge('join', END)
    .compile({ checkpointer: new MemoryGraphCheckpointer() });

  const result = await build(false).invoke({}, { threadId: 't', config: undefined });
  assert.deepEqual(result.state.log, ['0:a', '0:b saw x=0', '1:join'], 'b 看不到同一步里 a 的写入；join 只运行一次');
  assert.equal(result.state.x, 1);

  await assert.rejects(build(true).invoke({}, { threadId: 't', config: undefined }), InvalidUpdateError);
});

test('Graph：interrupt 暂停整张图；恢复时节点从头重跑，interrupt 之前的副作用执行了两次；多次 interrupt 按顺序取值', async () => {
  let sideEffects = 0;
  const graph = new StateGraph<{ answers: string[] }, { user: string }>({ initial: () => ({ answers: [] }) })
    .addNode('ask', (_s, ctx) => {
      sideEffects += 1;
      const first = ctx.interrupt<string>('第一个问题');
      const second = ctx.interrupt<string>('第二个问题');
      return { answers: [first, second, ctx.config.user] };
    })
    .addEdge(START, 'ask').addEdge('ask', END)
    .compile({ checkpointer: new MemoryGraphCheckpointer() });
  const options = { threadId: 't', config: { user: 'alice' } };

  const paused = await graph.invoke({}, options);
  assert.deepEqual(paused.interrupt, { node: 'ask', payload: '第一个问题' });
  await assert.rejects(graph.invoke({}, options), /等待 resume/);
  const second = await graph.resume('A', options);
  assert.deepEqual(second.interrupt, { node: 'ask', payload: '第二个问题' });
  const done = await graph.resume('B', options);
  assert.deepEqual(done.state.answers, ['A', 'B', 'alice']);
  assert.equal(sideEffects, 3, 'ask 节点执行了 3 次：首次 + 每次恢复');
});

test('Graph：失败的一步不提交，检查点停在上一步，invoke(null) 重试；结构错误在编译时报出', async () => {
  let attempts = 0;
  const graph = new StateGraph<{ ok: boolean }>({ initial: () => ({ ok: false }) })
    .addNode('flaky', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('下游超时');
      return { ok: true };
    })
    .addEdge(START, 'flaky').addEdge('flaky', END)
    .compile({ checkpointer: new MemoryGraphCheckpointer() });
  await assert.rejects(graph.invoke({}, { threadId: 't', config: undefined }), /下游超时/);
  assert.deepEqual(graph.getState('t')!.next, ['flaky']);
  assert.equal((await graph.invoke(null, { threadId: 't', config: undefined })).state.ok, true);

  const g = () => new StateGraph<{ v: number }>({ initial: () => ({ v: 0 }) }).addNode('a', () => ({})).addEdge(START, 'a');
  assert.throws(() => g().compile({ checkpointer: new MemoryGraphCheckpointer() }), /节点 a 没有出边/);
  assert.throws(() => g().addEdge('a', 'missing').compile({ checkpointer: new MemoryGraphCheckpointer() }), /目标节点不存在/);
  const bad = g().addConditionalEdges('a', () => 'b', [END]).compile({ checkpointer: new MemoryGraphCheckpointer() });
  await assert.rejects(bad.invoke({}, { threadId: 't', config: undefined }), /未声明的去向 b/);
});

// ── 混合：Graph 管流程，节点里跑 Agent Loop ─────────────────────────────

function ticketGraph(store = new Store(), checkpointer = new MemoryGraphCheckpointer<TicketState>()) {
  return { store, checkpointer, graph: createTicketGraph({ store, model: createMockModel(), checkpointer }) };
}

test('混合图：提问只走 classify → research → respond，模型调用 2 次，回答带来源', async () => {
  const { store, graph } = ticketGraph();
  const run = store.createRun(alice, '差旅住宿报销上限是多少');
  const result = await graph.invoke({ question: run.question }, { threadId: run.id, config: { user: alice, runId: run.id } });
  assert.equal(result.status, 'done');
  assert.deepEqual(result.state.trace, ['0:classify', '1:research', '2:respond']);
  assert.deepEqual(result.state.sources, ['acme-travel@v2']);
  assert.match(result.state.reply, /一线城市每晚 500 元/);
  assert.equal(result.state.modelCalls, 2);
});

test('混合图：报修时 research 与 lookupTickets 并发；停在审批；换一个图实例恢复后只建一张工单', async () => {
  const { store, checkpointer, graph } = ticketGraph();
  const run = store.createRun(alice, question);
  const config = { threadId: run.id, config: { user: alice, runId: run.id } };
  const paused = await graph.invoke({ question }, config);
  assert.equal(paused.status, 'interrupted');
  assert.match((paused.interrupt!.payload as { summary: string }).summary, /VPN 连不上/);
  assert.deepEqual(paused.state.trace, ['0:classify', '1:research', '1:lookupTickets', '2:draft']);
  assert.equal(store.tickets('acme').length, 0);

  const restarted = createTicketGraph({ store, model: createMockModel(), checkpointer });
  const done = await restarted.resume(true, config);
  assert.match(done.state.reply, /VPN 故障处理指南[\s\S]*工单已创建，编号 TCK-/);
  assert.deepEqual(done.state.trace.slice(4), ['3:approve', '4:create', '5:respond']);
  assert.equal(store.tickets('acme').length, 1);
});

test('混合图：拒绝不建单；已有同名未结工单时直接回复，不再请求审批', async () => {
  const { store, graph } = ticketGraph();
  const rejectRun = store.createRun(alice, question);
  const rejectConfig = { threadId: rejectRun.id, config: { user: alice, runId: rejectRun.id } };
  await graph.invoke({ question }, rejectConfig);
  assert.match((await graph.resume(false, rejectConfig)).state.reply, /你拒绝了创建工单/);
  assert.equal(store.tickets('acme').length, 0);

  const first = store.createRun(alice, question);
  await graph.invoke({ question }, { threadId: first.id, config: { user: alice, runId: first.id } });
  await graph.resume(true, { threadId: first.id, config: { user: alice, runId: first.id } });
  const again = store.createRun(alice, question);
  const result = await graph.invoke({ question }, { threadId: again.id, config: { user: alice, runId: again.id } });
  assert.equal(result.status, 'done');
  assert.match(result.state.reply, /你已经有一张未结工单/);
  assert.equal(store.tickets('acme').length, 1);
});

test('混合图：时间旅行回到审批检查点再恢复一次，create 节点重跑，幂等键保证仍然只有一张工单', async () => {
  const { store, graph } = ticketGraph();
  const run = store.createRun(alice, question);
  const config = { threadId: run.id, config: { user: alice, runId: run.id } };
  const paused = await graph.invoke({ question }, config);
  const first = await graph.resume(true, config);
  const replayed = await graph.resume(true, { ...config, checkpointId: paused.checkpointId });
  assert.equal(replayed.state.ticketId, first.state.ticketId);
  assert.equal(store.tickets('acme').length, 1);
  const forks = graph.getHistory(run.id).filter((c) => c.parentId === paused.checkpointId);
  assert.equal(forks.length, 2, '同一个检查点长出了两条分支');
});

test('同一个报修请求：纯 Agent Loop（带 harness）调用模型 4 次，混合图 2 次', async () => {
  const store = new Store();
  const harness = new Harness({ model: createMockModel(), tools: createTools(store), checkpointer: new MemoryCheckpointer() });
  const loopRun = store.createRun(alice, question);
  const paused = await harness.start(loopRun.id, alice, question);
  harness.decide(loopRun.id, alice, paused.pending!.callId, true);
  const loopDone = await harness.resume(loopRun.id, alice);
  assert.equal(loopDone.state.steps, 4);

  const { graph } = ticketGraph(store);
  const graphRun = store.createRun(bob, '显示器坏了，申请报修');
  const config = { threadId: graphRun.id, config: { user: bob, runId: graphRun.id } };
  await graph.invoke({ question: graphRun.question }, config);
  assert.equal((await graph.resume(true, config)).state.modelCalls, 2);
});
