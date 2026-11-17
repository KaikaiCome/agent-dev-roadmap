import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent, SHUTDOWN } from '../src/agent.ts';
import { findUser } from '../src/data/seed.ts';
import { evalCases } from '../src/eval/cases.ts';
import { runCase } from '../src/eval/evaluate.ts';
import { createMockModel, createScriptedModel } from '../src/llm/mock.ts';
import type { ChatModel, Message } from '../src/llm/types.ts';
import { Store } from '../src/store.ts';
import { subagentTool, treeEvents } from '../src/subagent.ts';
import { createTools } from '../src/tools/index.ts';
import { knowledgeTool } from '../src/tools/knowledge.ts';
import { ticketTools } from '../src/tools/tickets.ts';
import type { Tool } from '../src/tools/types.ts';

const alice = findUser('alice')!;
const carol = findUser('carol')!;

function researchResult(store: Store, runId: string) {
  const finished = store.events(runId).find((e) => e.type === 'tool_finished' && e.data.name === 'research');
  assert.ok(finished?.type === 'tool_finished');
  return finished.data;
}

test('子 Agent 是父 run 的一次工具调用：独立 run、上下文隔离、只回传压缩结论，调用树可还原', async () => {
  const store = new Store(':memory:');
  const childViews: Message[][] = [];
  const mock = createMockModel();
  const childModel: ChatModel = { name: 'child', complete: (request) => { childViews.push(request.messages); return mock.complete(request); } };
  let parentSeen: Message[] = [];
  const parentModel = createScriptedModel([
    { toolCalls: [{ name: 'research', args: { task: '差旅住宿报销上限是多少' } }] },
    (messages) => { parentSeen = messages; return { content: '完成' }; },
  ]);
  const research = subagentTool({ model: childModel, store, tools: [knowledgeTool()], maxSummaryChars: 30 });
  const parent = store.createRun(alice, '我下周去北京出差，住宿能报多少？');
  assert.equal(await runAgent(parent.id, alice, { model: parentModel, store, tools: [research] }), 'completed');

  assert.ok(childViews[0][0].content.includes('调研子 Agent'), '子 Agent 有自己的提示词');
  assert.deepEqual(childViews[0].slice(1), [{ role: 'user', content: '差旅住宿报销上限是多少' }], '子 Agent 只看到任务，看不到父 Agent 的对话');

  const result = researchResult(store, parent.id);
  const data = result.result as { childRunId: string; summary: string; sources: string[] };
  assert.deepEqual(data.sources, ['acme-travel@v2']);
  assert.ok(data.summary.endsWith('…（已截断）') && data.summary.length <= 30 + 6);
  const parentToolText = parentSeen.filter((m) => m.role === 'tool').map((m) => m.content).join('');
  assert.ok(!parentToolText.includes('350 元'), '完整检索结果留在子 run 里，不进父 Agent 的上下文');

  const [child] = store.childRuns(parent.id);
  assert.equal(child.id, data.childRunId);
  assert.equal(child.status, 'completed');
  const started = store.events(child.id)[0];
  assert.ok(started.type === 'run_started');
  assert.deepEqual([started.data.parentRunId, started.data.parentCallId, started.data.agent], [parent.id, 'call_1_0', 'research']);
  assert.ok(store.events(child.id).some((e) => e.type === 'tool_finished' && JSON.stringify(e.data).includes('350 元')), '子 run 的日志里有完整的检索结果，审计能查到');
  assert.equal(treeEvents(store, parent.id).length, store.events(parent.id).length + store.events(child.id).length);
  assert.deepEqual(store.runsWithStatus('completed').map((r) => r.id), [parent.id], '子 run 不出现在顶层 run 列表里');
});

test('子 Agent 只能装配只读工具；预算独立，超预算时父 Agent 收到失败结果并继续', async () => {
  const store = new Store(':memory:');
  assert.throws(() => subagentTool({ model: createMockModel(), store, tools: ticketTools(store) }), /只能使用只读工具.*prepare_ticket, create_ticket/);

  const looping = createScriptedModel([
    { toolCalls: [{ name: 'search_knowledge', args: { query: '差旅' } }] },
    { toolCalls: [{ name: 'search_knowledge', args: { query: '住宿' } }] },
  ]);
  const research = subagentTool({ model: looping, store, tools: [knowledgeTool()], maxSteps: 2 });
  const parentModel = createScriptedModel([
    { toolCalls: [{ name: 'research', args: { task: '差旅住宿报销上限' } }] },
    { content: '调研没有完成，无法确认' },
  ]);
  const parent = store.createRun(alice, '住宿上限？');
  assert.equal(await runAgent(parent.id, alice, { model: parentModel, store, tools: [research] }), 'completed');
  assert.equal(researchResult(store, parent.id).error?.code, 'SUBAGENT_INCOMPLETE');
  assert.equal(store.childRuns(parent.id)[0].status, 'budget_exceeded');
});

test('子 Agent 编造的引用不会传回父 Agent', async () => {
  const store = new Store(':memory:');
  const liar = createScriptedModel([{ content: 'Q4 预算已冻结 [acme-budget@v1]' }]);
  const research = subagentTool({ model: liar, store, tools: [knowledgeTool()] });
  const parentModel = createScriptedModel([{ toolCalls: [{ name: 'research', args: { task: 'Q4 预算' } }] }, { content: '完成' }]);
  const parent = store.createRun(alice, 'Q4 预算冻结了吗？');
  await runAgent(parent.id, alice, { model: parentModel, store, tools: [research] });
  const data = researchResult(store, parent.id).result as { sources: string[]; unverified: string[] };
  assert.deepEqual(data.sources, []);
  assert.deepEqual(data.unverified, ['acme-budget@v1']);
});

test('子 Agent 和父 Agent 是同一个员工身份：看不到员工自己无权查看的文档', async () => {
  for (const [user, visible] of [[alice, false], [carol, true]] as const) {
    const store = new Store(':memory:');
    const run = store.createRun(user, 'Q4 部门预算冻结了吗？');
    assert.equal(await runAgent(run.id, user, { model: createMockModel(), store, tools: createTools(store, { subagent: { model: createMockModel() } }) }), 'completed');
    const [child] = store.childRuns(run.id);
    assert.deepEqual([child.userId, child.tenantId], [user.id, user.tenantId]);
    const tree = JSON.stringify(treeEvents(store, run.id));
    assert.equal(tree.includes('acme-budget'), visible, `${user.id} ${visible ? '能' : '不能'}看到预算文档`);
    const answer = store.events(run.id).findLast((e) => e.type === 'assistant_message');
    assert.ok(answer?.type === 'assistant_message' && answer.data.content.includes(visible ? '[acme-budget@v1]' : '无法'));
  }
});

test('取消从父 run 传到子 run；服务重启后父 run 接着跑原来的子 run，而不是再开一个', async () => {
  let trigger: (() => void) | undefined;
  const slow: Tool<unknown> = {
    readOnly: true,
    spec: { name: 'slow_read', description: '', parameters: {} },
    parse: (a) => a,
    run: async () => { trigger?.(); trigger = undefined; await new Promise((r) => setTimeout(r, 5)); return { text: '资料 [doc@v1]' }; },
  };

  const store = new Store(':memory:');
  const cancel = new AbortController();
  trigger = () => cancel.abort();
  const research = subagentTool({ model: createScriptedModel([{ toolCalls: [{ name: 'slow_read', args: {} }] }]), store, tools: [slow] });
  const parent = store.createRun(alice, '取消');
  const parentModel = createScriptedModel([{ toolCalls: [{ name: 'research', args: { task: '查资料' } }] }]);
  assert.equal(await runAgent(parent.id, alice, { model: parentModel, store, tools: [research] }, cancel.signal), 'cancelled');
  assert.equal(store.childRuns(parent.id)[0].status, 'cancelled');

  const store2 = new Store(':memory:');
  const shutdown = new AbortController();
  trigger = () => shutdown.abort(SHUTDOWN);
  const childModel = createScriptedModel([{ toolCalls: [{ name: 'slow_read', args: {} }] }, { content: '结论' }]);
  const research2 = subagentTool({ model: childModel, store: store2, tools: [slow] });
  const parentModel2 = createScriptedModel([{ toolCalls: [{ name: 'research', args: { task: '查资料' } }] }, { content: '完成' }]);
  const parent2 = store2.createRun(alice, '重启');
  const options = { model: parentModel2, store: store2, tools: [research2] };
  assert.equal(await runAgent(parent2.id, alice, options, shutdown.signal), 'running');
  assert.equal(store2.childRuns(parent2.id)[0].status, 'running');
  assert.deepEqual(store2.runsWithStatus('running').map((r) => r.id), [parent2.id], '重启后只恢复顶层 run');

  assert.equal(await runAgent(parent2.id, alice, options), 'completed');
  const children = store2.childRuns(parent2.id);
  assert.equal(children.length, 1);
  assert.equal(children[0].status, 'completed');
  assert.equal((researchResult(store2, parent2.id).result as { childRunId: string }).childRunId, children[0].id);
});

test('评测：检索交给子 Agent 后全部用例仍然通过，但整棵调用树的 token 明显更多', async () => {
  const model = createMockModel();
  let single = 0;
  let delegated = 0;
  for (const testCase of evalCases) {
    const a = await runCase(testCase, model);
    const b = await runCase(testCase, model, undefined, { subagent: true });
    assert.ok(a.passed && b.passed, `${testCase.id}：${[...a.failures, ...b.failures].join('；')}`);
    single += a.inputTokens + a.outputTokens;
    delegated += b.inputTokens + b.outputTokens;
  }
  assert.ok(delegated > single * 1.3, `单 Agent ${single}，子 Agent ${delegated}`);
});
