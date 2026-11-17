import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import { MemorySession, setTraceProcessors, type Span } from '@openai/agents';
import { users } from '../../src/data/seed.ts';
import { createMockModel } from '../../src/llm/mock.ts';
import type { ChatModel, Message, ToolSpec } from '../../src/llm/types.ts';
import { systemPrompt } from '../../src/prompt.ts';
import { Store } from '../../src/store.ts';
import { createTools } from '../../src/tools/index.ts';
import { agentsSdk, handRolled, langGraph, normalizeAnswer, type Step } from '../compare.ts';
import { createTicketGraph, pendingApprovals, threadConfig } from '../langgraph.ts';
import { createRunner, createTicketAgent, rejectOptions, restoreState } from '../openai-agents.ts';
import { startConversation } from '../shared.ts';

const [alice, carol, bob] = users;
const REFUSAL = /没有找到你有权限查看的相关制度/;

// Agents SDK 默认把追踪上传到 OpenAI；测试里换成本地收集器，既保证离线，也能断言 span
const spans: string[] = [];
setTraceProcessors([{
  async onTraceStart() {},
  async onTraceEnd() {},
  async onSpanStart() {},
  async onSpanEnd(span: Span<any>) {
    spans.push(span.spanData.type === 'function' ? `function:${span.spanData.name}` : span.spanData.type);
  },
  async shutdown() {},
  async forceFlush() {},
}]);

/** 记录每次模型调用收到的消息，用来检查工具结果和多轮历史 */
function recording(model: ChatModel = createMockModel()) {
  const requests: Message[][] = [];
  const wrapped: ChatModel = { name: model.name, complete: (request) => (requests.push(request.messages), model.complete(request)) };
  return { model: wrapped, requests };
}

const toolResults = (requests: Message[][]) => requests.at(-1)!.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
const userTurns = (requests: Message[][]) => requests.at(-1)!.filter((m) => m.role === 'user').map((m) => m.content);
const toolStarts = (names: string[]) => [{ handleToolStart: (...args: unknown[]) => void names.push(String(args[6])) }];

test('同一组对话，手写版、Agents SDK、LangGraph 给出逐字相同的回答和同样多的工单', async () => {
  const steps: Step[] = [
    { user: alice, question: '差旅住宿报销上限是多少' },
    { user: alice, question: 'VPN 连不上，帮我提交工单', approve: true },
    { user: alice, question: '显示器坏了，申请报修', approve: false },
    { user: bob, question: '差旅住宿报销上限是多少' },
    { user: alice, question: 'Q4 预算冻结了吗' },
  ];
  const [hand, sdk, graph] = await Promise.all([handRolled, agentsSdk, langGraph].map((run) => run(steps, createMockModel())));
  for (const result of [sdk, graph]) {
    assert.deepEqual(result.turns.map((t) => normalizeAnswer(t.answer)), hand.turns.map((t) => normalizeAnswer(t.answer)));
    assert.deepEqual(result.turns.map((t) => t.approval), hand.turns.map((t) => t.approval));
    assert.equal(result.modelCalls, hand.modelCalls);
    assert.equal(result.tickets, 1);
  }
});

test('工具契约：两个框架发给模型的工具名、字段说明和系统提示词与手写版一致；Agents SDK 的 strict 模式把可选字段变成必填', async () => {
  const store = new Store(':memory:');
  const reference = createTools(store).map((tool) => tool.spec);
  const sent: ToolSpec[][] = [];
  const systems: string[][] = [];
  const inner = createMockModel();
  const model: ChatModel = {
    name: 'capture',
    complete: (request) => (sent.push(request.tools ?? []), systems.push(request.messages.filter((m) => m.role === 'system').map((m) => m.content)), inner.complete(request)),
  };

  await createRunner(model).run(createTicketAgent(store).agent, '会议室怎么预订', { context: startConversation(store, alice, 't') });
  await createTicketGraph(store, model, new MemorySaver()).invoke({ messages: [new HumanMessage('会议室怎么预订')] }, threadConfig(startConversation(store, alice, 't')));
  const [sdkTools, graphTools] = [sent[0], sent.at(-1)!];

  const contract = (specs: ToolSpec[]) => specs.map(({ name, description, parameters }) => ({
    name,
    description,
    fields: Object.entries(parameters.properties as Record<string, { description?: string }>).map(([key, value]) => [key, value.description]),
  }));
  assert.deepEqual(contract(sdkTools), contract(reference));
  assert.deepEqual(contract(graphTools), contract(reference));

  const required = (specs: ToolSpec[]) => specs.find((spec) => spec.name === 'prepare_ticket')!.parameters.required;
  assert.deepEqual(required(reference), ['title', 'description']);
  assert.deepEqual(required(graphTools), ['title', 'description']);
  assert.deepEqual(required(sdkTools), ['title', 'description', 'sourceIds']);
  // 两个框架都没有追加隐藏的系统提示词：每次请求只有一条 system，内容就是参考项目的 systemPrompt
  for (const messages of systems) assert.deepEqual(messages, [systemPrompt(alice)]);
});

test('Agents SDK：检索沿用参考项目的权限过滤，工具调用出现在追踪里', async () => {
  const store = new Store(':memory:');
  const { agent } = createTicketAgent(store);
  const { model, requests } = recording();
  spans.length = 0;

  const forBob = await createRunner(model).run(agent, '差旅住宿报销上限是多少', { context: startConversation(store, bob, 't') });
  assert.match(String(forBob.finalOutput), /globex-travel@v1/);
  assert.doesNotMatch(JSON.stringify(requests), /acme-/, '其他租户的文档不能进入模型上下文');
  assert.ok(spans.includes('function:search_knowledge'));

  const forCarol = await createRunner(model).run(agent, 'Q4 预算冻结了吗', { context: startConversation(store, carol, 't') });
  assert.match(String(forCarol.finalOutput), /acme-budget@v1/);
});

test('Agents SDK：没有可见依据时拒答，不编造', async () => {
  const store = new Store(':memory:');
  const { agent } = createTicketAgent(store);
  const { model, requests } = recording();
  const result = await createRunner(model).run(agent, 'Q4 预算冻结了吗', { context: startConversation(store, alice, 't') });
  assert.match(String(result.finalOutput), REFUSAL);
  assert.deepEqual(toolResults(requests)[0].data.results, []);
});

test('Agents SDK：needsApproval 暂停 run；序列化后用当前身份恢复，同意只建一张工单，重复恢复也不会多建', async () => {
  const store = new Store(':memory:');
  const { agent, describe } = createTicketAgent(store);
  const runner = createRunner(createMockModel());
  const context = startConversation(store, alice, 't');

  const paused = await runner.run(agent, 'VPN 连不上，帮我提交工单', { context });
  assert.equal(paused.interruptions.length, 1);
  assert.equal(paused.interruptions[0].name, 'create_ticket');
  assert.match(describe(paused.interruptions[0], context), /提交工单「VPN 连不上/);
  assert.equal(store.tickets('acme').length, 0, '审批前不执行');

  const saved = paused.state.toString();
  const resume = async () => {
    const state = await restoreState(agent, saved, context);
    for (const item of state.getInterruptions()) state.approve(item);
    return runner.run(agent, state);
  };
  assert.match(String((await resume()).finalOutput), /工单已创建，编号 TCK-/);
  // 同一个审批状态被恢复两次（重复点击、两个 worker 抢到同一条任务）：工具确实又执行了一次，靠参考项目的幂等键只建一张
  assert.match(String((await resume()).finalOutput), /工单已创建/);
  assert.equal(store.tickets('acme').length, 1);
});

test('Agents SDK：拒绝后模型收到 APPROVAL_REJECTED，不建单', async () => {
  const store = new Store(':memory:');
  const { agent } = createTicketAgent(store);
  const { model, requests } = recording();
  const runner = createRunner(model);
  const paused = await runner.run(agent, '显示器坏了，申请报修', { context: startConversation(store, alice, 't') });
  for (const item of paused.interruptions) paused.state.reject(item, rejectOptions);
  const result = await runner.run(agent, paused.state);
  assert.match(String(result.finalOutput), /你拒绝了创建工单/);
  assert.equal(toolResults(requests).at(-1).error.code, 'APPROVAL_REJECTED');
  assert.equal(store.tickets('acme').length, 0);
});

test('Agents SDK：Session 保存多轮历史；流式输出拼起来等于最终回答', async () => {
  const store = new Store(':memory:');
  const { agent } = createTicketAgent(store);
  const { model, requests } = recording();
  const runner = createRunner(model);
  const context = startConversation(store, alice, 't');
  const session = new MemorySession();

  await runner.run(agent, '差旅住宿报销上限是多少', { context, session });
  const stream = await runner.run(agent, '会议室怎么预订', { context, session, stream: true });
  const deltas: string[] = [];
  for await (const delta of stream.toTextStream()) deltas.push(delta);
  await stream.completed;

  assert.ok(deltas.length > 1, '应当分多段到达');
  assert.equal(deltas.join(''), stream.finalOutput);
  assert.deepEqual(userTurns(requests), ['差旅住宿报销上限是多少', '会议室怎么预订']);
});

test('LangGraph：检索沿用权限过滤；工具调用触发回调（追踪）；没有依据时拒答', async () => {
  const store = new Store(':memory:');
  const { model, requests } = recording();
  const graph = createTicketGraph(store, model, new MemorySaver());
  const started: string[] = [];

  const forBob = await graph.invoke({ messages: [new HumanMessage('差旅住宿报销上限是多少')] }, { ...threadConfig(startConversation(store, bob, 't')), callbacks: toolStarts(started) });
  assert.match(forBob.messages.at(-1)!.text, /globex-travel@v1/);
  assert.doesNotMatch(JSON.stringify(requests), /acme-/);
  assert.deepEqual(started, ['search_knowledge']);

  const forAlice = await graph.invoke({ messages: [new HumanMessage('Q4 预算冻结了吗')] }, threadConfig(startConversation(store, alice, 't')));
  assert.match(forAlice.messages.at(-1)!.text, REFUSAL);
  assert.deepEqual(toolResults(requests)[0].data.results, []);
});

test('LangGraph：interrupt 暂停在审批节点；换一个图实例（模拟重启）恢复，已执行的工具不会重跑', async () => {
  const store = new Store(':memory:');
  const checkpointer = new MemorySaver();
  const config = threadConfig(startConversation(store, alice, 't'));
  const started: string[] = [];

  const paused = await createTicketGraph(store, createMockModel(), checkpointer).invoke({ messages: [new HumanMessage('VPN 连不上，帮我提交工单')] }, { ...config, callbacks: toolStarts(started) });
  assert.equal((paused as { __interrupt__?: unknown[] }).__interrupt__?.length, 1, '暂停信息通过 __interrupt__ 返回');
  const [request] = await pendingApprovals(createTicketGraph(store, createMockModel(), checkpointer), config);
  assert.match(request.summary, /提交工单「VPN 连不上/);
  assert.equal(store.tickets('acme').length, 0);

  const done = await createTicketGraph(store, createMockModel(), checkpointer).invoke(new Command({ resume: { [request.callId]: true } }), { ...config, callbacks: toolStarts(started) });
  assert.match(done.messages.at(-1)!.text, /工单已创建，编号 TCK-/);
  assert.deepEqual(started, ['search_knowledge', 'prepare_ticket', 'create_ticket']);
  assert.equal(store.tickets('acme').length, 1);
});

test('LangGraph：拒绝不建单；从审批前的检查点重放会再次执行写工具，只靠幂等键挡住重复', async () => {
  const store = new Store(':memory:');
  const graph = createTicketGraph(store, createMockModel(), new MemorySaver());

  const rejectThread = threadConfig(startConversation(store, alice, 't'));
  await graph.invoke({ messages: [new HumanMessage('显示器坏了，申请报修')] }, rejectThread);
  const [rejected] = await pendingApprovals(graph, rejectThread);
  const afterReject = await graph.invoke(new Command({ resume: { [rejected.callId]: false } }), rejectThread);
  assert.match(afterReject.messages.at(-1)!.text, /你拒绝了创建工单/);
  assert.equal(store.tickets('acme').length, 0);

  const config = threadConfig(startConversation(store, alice, 't'));
  await graph.invoke({ messages: [new HumanMessage('VPN 连不上，帮我提交工单')] }, config);
  const interrupted = await graph.getState(config);
  const [request] = await pendingApprovals(graph, config);
  await graph.invoke(new Command({ resume: { [request.callId]: true } }), config);

  // “时间旅行”：带上审批前的 checkpoint_id 再恢复一次，等价于重试一个其实已经成功的请求
  const replayed: string[] = [];
  const old = { ...interrupted.config, configurable: { ...interrupted.config.configurable, user: alice } };
  await graph.invoke(new Command({ resume: { [request.callId]: true } }), { ...old, callbacks: toolStarts(replayed) });
  assert.ok(replayed.includes('create_ticket'), '重放确实再次执行了写工具');
  assert.equal(store.tickets('acme').length, 1);
});

test('LangGraph：同一线程保留多轮历史，不同线程互不可见；streamMode messages 逐段输出', async () => {
  const store = new Store(':memory:');
  const { model, requests } = recording();
  const graph = createTicketGraph(store, model, new MemorySaver());
  const config = threadConfig(startConversation(store, alice, 't'));

  await graph.invoke({ messages: [new HumanMessage('差旅住宿报销上限是多少')] }, config);
  const deltas: string[] = [];
  for await (const [chunk, metadata] of await graph.stream({ messages: [new HumanMessage('会议室怎么预订')] }, { ...config, streamMode: 'messages' })) {
    if (metadata.langgraph_node === 'agent' && chunk.text) deltas.push(chunk.text);
  }
  const final = (await graph.getState(config)).values.messages.at(-1)!.text;
  assert.ok(deltas.length > 1);
  assert.equal(deltas.join(''), final);
  assert.deepEqual(userTurns(requests), ['差旅住宿报销上限是多少', '会议室怎么预订']);

  await graph.invoke({ messages: [new HumanMessage('婚假有几天')] }, threadConfig(startConversation(store, alice, 't')));
  assert.deepEqual(userTurns(requests), ['婚假有几天']);
});
