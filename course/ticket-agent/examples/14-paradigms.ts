// 第 28 章：三种工作范式跑同一个请求，再做两组失败实验。全部离线，不需要 API key。
// 运行：npm run paradigms
import { findUser } from '../src/data/seed.ts';
import { createMockModel } from '../src/llm/mock.ts';
import type { ChatModel } from '../src/llm/types.ts';
import { MemoryGraphCheckpointer } from '../src/paradigms/graph.ts';
import { Harness, MemoryCheckpointer } from '../src/paradigms/harness.ts';
import { agentLoop, newLoopState } from '../src/paradigms/loop.ts';
import { createTicketGraph, type TicketState } from '../src/paradigms/ticket-graph.ts';
import { systemPrompt } from '../src/prompt.ts';
import { Store } from '../src/store.ts';
import { createTools } from '../src/tools/index.ts';
import type { Tool } from '../src/tools/types.ts';

const alice = findUser('alice')!;
const question = 'VPN 连不上，帮我提交工单';

function counted(model: ChatModel) {
  const wrapper = { name: model.name, calls: 0, complete: (request: Parameters<ChatModel['complete']>[0]) => {
    wrapper.calls += 1;
    return model.complete(request);
  } };
  return wrapper;
}

const rows: string[][] = [];

// 1. 裸 Agent Loop：只有内核
{
  const store = new Store();
  const model = counted(createMockModel());
  const run = store.createRun(alice, question);
  const tools = createTools(store);
  await agentLoop(newLoopState(systemPrompt(alice, new Date(), tools.map((t) => t.spec.name)), question), { model, tools, user: alice, runId: run.id });
  rows.push(['裸 Agent Loop', String(model.calls), '否（直接执行）', String(store.tickets('acme').length)]);
}

// 2. Agent Loop + Harness：同一个内核，接上预算、审批、错误信封、检查点
{
  const store = new Store();
  const model = counted(createMockModel());
  const harness = new Harness({ model, tools: createTools(store), checkpointer: new MemoryCheckpointer() });
  const run = store.createRun(alice, question);
  const paused = await harness.start(run.id, alice, question);
  const before = store.tickets('acme').length;
  harness.decide(run.id, alice, paused.pending!.callId, true);
  await harness.resume(run.id, alice);
  rows.push(['Agent Loop + Harness', String(model.calls), before === 0 ? '是' : '否', String(store.tickets('acme').length)]);
}

// 3. Graph 管流程 + 节点里的 Agent Loop
let graphThread = '';
const graphCheckpointer = new MemoryGraphCheckpointer<TicketState>();
const graphStore = new Store();
const graph = createTicketGraph({ store: graphStore, model: createMockModel(), checkpointer: graphCheckpointer });
{
  const run = graphStore.createRun(alice, question);
  graphThread = run.id;
  const options = { threadId: run.id, config: { user: alice, runId: run.id } };
  const paused = await graph.invoke({ question }, options);
  const before = graphStore.tickets('acme').length;
  const done = await graph.resume(true, options);
  rows.push(['Graph（混合）', String(done.state.modelCalls), paused.status === 'interrupted' && before === 0 ? '是' : '否', String(graphStore.tickets('acme').length)]);
}

console.log(`同一个请求：「${question}」，员工同意建单\n`);
table(['实现', '模型调用', '审批前无副作用', '工单'], rows);

// 失败实验 1：模型原地打转
console.log('\n失败实验 1：模型每一轮都用同样的参数调用检索，永远不回答');
const spinning = () => ({
  name: 'runaway',
  calls: 0,
  async complete() {
    this.calls += 1;
    return {
      message: { role: 'assistant' as const, content: '', toolCalls: [{ id: `c${this.calls}`, name: 'search_knowledge', arguments: '{"query":"VPN"}' }] },
      usage: { inputTokens: 100, outputTokens: 10 },
      finishReason: 'tool_calls',
    };
  },
});
{
  const store = new Store();
  const bare = spinning();
  const error = await agentLoop(newLoopState('sys', 'VPN'), { model: bare, tools: createTools(store), user: alice, runId: 'r' }).catch((e: Error) => e.message);
  const guarded = spinning();
  const record = await new Harness({ model: guarded, tools: createTools(store), checkpointer: new MemoryCheckpointer() }).start('r', alice, 'VPN');
  table(['实现', '模型调用', '结果'], [
    ['裸 Agent Loop', String(bare.calls), String(error)],
    ['Agent Loop + Harness', String(guarded.calls), `${record.status}：${record.reason}`],
  ]);
}

// 失败实验 2：工单建好了，进程在记录结果之前崩溃，然后重启
console.log('\n失败实验 2：create_ticket 执行成功后、结果落盘前进程崩溃，然后重启');
{
  const store = new Store();
  const crashing = createTools(store).map((tool): Tool => tool.spec.name !== 'create_ticket' ? tool : {
    ...tool,
    async run(args, context) {
      await tool.run(args, context);
      throw new Error('进程崩溃');
    },
  });
  const first = store.createRun(alice, question);
  await agentLoop(newLoopState('sys', question), { model: createMockModel(), tools: crashing, user: alice, runId: first.id }).catch(() => undefined);
  // 内存里的状态随进程消失，只能重新发起一个 run
  const retry = store.createRun(alice, question);
  await agentLoop(newLoopState('sys', question), { model: createMockModel(), tools: createTools(store), user: alice, runId: retry.id });
  const bareTickets = store.tickets('acme').length;

  const harnessStore = new Store();
  const checkpointer = new MemoryCheckpointer();
  const run = harnessStore.createRun(alice, question);
  const harness = new Harness({ model: createMockModel(), tools: createTools(harnessStore), checkpointer });
  const paused = await harness.start(run.id, alice, question);
  harness.decide(run.id, alice, paused.pending!.callId, true);
  checkpointer.crashBeforeSave = (r) => r.state.messages.at(-1)?.role === 'tool' && r.state.messages.at(-1)!.content.includes('ticketId');
  await harness.resume(run.id, alice).catch(() => undefined);
  checkpointer.crashBeforeSave = undefined;
  const recovered = await new Harness({ model: createMockModel(), tools: createTools(harnessStore), checkpointer }).resume(run.id, alice);
  table(['实现', '重启后怎么做', '工单'], [
    ['裸 Agent Loop', '状态丢失，从头再来（新 runId = 新幂等键）', String(bareTickets)],
    ['Agent Loop + Harness', `从检查点恢复，重跑 create_ticket（${recovered.status}）`, String(harnessStore.tickets('acme').length)],
  ]);
}

console.log('\nGraph 的检查点历史（每走完一步存一个；在审批处中断时多存一个）：');
table(['检查点', 'step', '刚运行完的节点', '下一步'], graph.getHistory(graphThread).map((checkpoint) => [
  `#${checkpoint.id}`,
  String(checkpoint.step),
  checkpoint.ran.length ? checkpoint.ran.join(' + ') : checkpoint.interrupt ? `（${checkpoint.interrupt.node} 中断）` : '（输入）',
  checkpoint.next.join(', ') || 'END',
]));

console.log('\n流程图（Mermaid，可粘贴到 https://mermaid.live 查看）：');
console.log(graph.toMermaid());

function table(header: string[], body: string[][]) {
  const width = (text: string) => [...text].reduce((sum, ch) => sum + (ch.codePointAt(0)! > 0x2e80 ? 2 : 1), 0);
  const cols = header.map((_, i) => Math.max(...[header, ...body].map((row) => width(row[i]))));
  for (const row of [header, ...body]) console.log(row.map((cell, i) => cell + ' '.repeat(cols[i] - width(cell))).join('  ').trimEnd());
}
