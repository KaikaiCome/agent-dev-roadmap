// 第 28 章：混合范式——外层用 Graph 管业务阶段，节点内部跑带 harness 的 Agent Loop。
// 流程（Mermaid 见 graph.toMermaid()）：
//   START → classify ─┬→ research ──────┬→ draft → approve ─┬→ create → respond → END
//                     └→ lookupTickets ─┘   │               └→ respond
//                     （提问只走 research → respond）  └（已有同名未结工单）→ respond
// 哪些步骤交给模型、哪些写死在代码里，是这个范式的核心设计决定：
// - 开放的部分（怎么检索、检索几次、怎么组织回答）交给 research 节点里的 Agent Loop；
// - 确定的部分（是不是报修、要不要查重、必须审批、建单、回复格式）写成节点和边，模型无法绕过。
import type { User } from '../data/seed.ts';
import type { ChatModel, Message } from '../llm/types.ts';
import { systemPrompt } from '../prompt.ts';
import type { Store } from '../store.ts';
import { knowledgeTool } from '../tools/knowledge.ts';
import { ticketTools } from '../tools/tickets.ts';
import type { ToolContext } from '../tools/types.ts';
import { StateGraph, END, START, type GraphCheckpointer, type NodeContext } from './graph.ts';
import { Harness, MemoryCheckpointer } from './harness.ts';

export interface TicketState {
  question: string;
  intent: 'ask' | 'ticket' | '';
  answer: string;
  sources: string[];
  /** 当前员工名下已有工单的标题 */
  openTickets: string[];
  duplicateOf: string;
  draftId: string;
  summary: string;
  approved: boolean | null;
  ticketId: string;
  reply: string;
  /** 每个节点运行时追加一条“第几步:节点名”，用来观察执行顺序和并发 */
  trace: string[];
  modelCalls: number;
}

/** 身份和 run 每次 invoke / resume 由服务端传入，不写进状态，所以检查点里没有、也无法被篡改 */
export interface TicketConfig {
  user: User;
  runId: string;
}

type Ctx = NodeContext<TicketConfig>;

const initial = (): TicketState => ({
  question: '', intent: '', answer: '', sources: [], openTickets: [], duplicateOf: '',
  draftId: '', summary: '', approved: null, ticketId: '', reply: '', trace: [], modelCalls: 0,
});

export function createTicketGraph(deps: { store: Store; model: ChatModel; checkpointer: GraphCheckpointer<TicketState> }) {
  const { store, model } = deps;
  const [prepareTicket, createTicket] = ticketTools(store);
  const knowledge = knowledgeTool();
  const toolContext = ({ config }: Ctx, callId: string): ToolContext =>
    ({ user: config.user, runId: config.runId, callId, signal: new AbortController().signal });
  const visit = (name: string, ctx: Ctx) => [`${ctx.step}:${name}`];

  return new StateGraph<TicketState, TicketConfig>({
    initial,
    reducers: {
      // 并发的节点都会写 trace 和 modelCalls：有 reducer 才能合并，否则运行时报 InvalidUpdateError
      trace: (current, update) => [...current, ...update],
      modelCalls: (current, update) => current + update,
    },
  })
    // 路由用规则而不是模型：便宜、确定、可测。换成模型分类时，也应该让它输出受 schema 约束的枚举值（第 24 章）
    .addNode('classify', (state, ctx) => ({
      intent: /工单|报修|提交|申请/.test(state.question) ? 'ticket' : 'ask',
      trace: visit('classify', ctx),
    }))

    // 混合范式的关键：节点内部是一个完整的、带 harness 的 Agent Loop，但只拿到只读工具。
    // 它能自由决定检索几次、怎么组织回答，却碰不到建单——写操作只在图里的固定节点发生
    .addNode('research', async (state, ctx) => {
      const harness = new Harness({
        model,
        tools: [knowledge],
        checkpointer: new MemoryCheckpointer(),
        policy: { maxSteps: 4 },
        systemPrompt: (user) => systemPrompt(user, new Date(), [knowledge.spec.name]),
      });
      const run = await harness.start(`${ctx.config.runId}:research:${ctx.step}`, ctx.config.user, state.question);
      return {
        answer: run.status === 'completed' ? run.answer! : '没有找到可靠依据，暂时无法回答。',
        sources: sourcesOf(run.state.messages),
        modelCalls: run.state.steps,
        trace: visit('research', ctx),
      };
    })

    .addNode('lookupTickets', (_state, ctx) => ({
      openTickets: store.tickets(ctx.config.user.tenantId).filter((t) => t.userId === ctx.config.user.id).map((t) => t.title),
      trace: visit('lookupTickets', ctx),
    }))

    // research 和 lookupTickets 都指向 draft（扇入）：draft 在下一步只运行一次，两边的结果都已合并进状态
    .addNode('draft', async (state, ctx) => {
      const title = state.question.slice(0, 40);
      if (state.openTickets.includes(title)) return { duplicateOf: title, trace: visit('draft', ctx) };
      const args = prepareTicket.parse({ title, description: `员工请求：${state.question}`, sourceIds: state.sources });
      const draft = await prepareTicket.run(args, toolContext(ctx, 'draft')) as { draftId: string };
      const summary = createTicket.describe!({ draftId: draft.draftId }, toolContext(ctx, 'create'));
      return { draftId: draft.draftId, summary, trace: visit('draft', ctx) };
    })

    // 审批节点只做一件事：中断并等人。没有任何副作用——恢复时这个节点会从头重跑
    .addNode('approve', (state, ctx) => {
      const approved = ctx.interrupt<unknown>({ kind: 'approval', draftId: state.draftId, summary: state.summary });
      if (typeof approved !== 'boolean') throw new Error('审批结果必须是 true / false');
      return { approved, trace: visit('approve', ctx) };
    })

    // 幂等键 = runId:create。无论这个节点因为重试、时间旅行被执行几次，都只有一张工单
    .addNode('create', async (state, ctx) => {
      const created = await createTicket.run({ draftId: state.draftId }, toolContext(ctx, 'create')) as { ticketId: string };
      return { ticketId: created.ticketId, trace: visit('create', ctx) };
    })

    .addNode('respond', (state, ctx) => {
      const parts = [state.answer];
      if (state.duplicateOf) parts.push(`你已经有一张未结工单「${state.duplicateOf}」，没有重复提交。`);
      else if (state.ticketId) parts.push(`工单已创建，编号 ${state.ticketId}。`);
      else if (state.approved === false) parts.push('你拒绝了创建工单，没有提交任何工单。');
      return { reply: parts.join('\n'), trace: visit('respond', ctx) };
    })

    .addEdge(START, 'classify')
    .addConditionalEdges('classify', (s) => (s.intent === 'ticket' ? ['research', 'lookupTickets'] : ['research']), ['research', 'lookupTickets'])
    .addConditionalEdges('research', (s) => (s.intent === 'ticket' ? 'draft' : 'respond'), ['draft', 'respond'])
    .addEdge('lookupTickets', 'draft')
    .addConditionalEdges('draft', (s) => (s.duplicateOf ? 'respond' : 'approve'), ['approve', 'respond'])
    .addConditionalEdges('approve', (s) => (s.approved ? 'create' : 'respond'), ['create', 'respond'])
    .addEdge('create', 'respond')
    .addEdge('respond', END)
    .compile({ checkpointer: deps.checkpointer });
}

/** 从 research 循环的对话里取出检索到的 sourceId */
function sourcesOf(messages: Message[]): string[] {
  const ids = messages.flatMap((message) => {
    if (message.role !== 'tool') return [];
    const result = JSON.parse(message.content) as { ok: boolean; data?: { results?: Array<{ sourceId: string }> } };
    return result.ok ? (result.data?.results ?? []).map((hit) => hit.sourceId) : [];
  });
  return [...new Set(ids)].slice(0, 5);
}
