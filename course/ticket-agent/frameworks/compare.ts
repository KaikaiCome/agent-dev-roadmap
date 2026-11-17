import { HumanMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import { MemorySession } from '@openai/agents';
import { resolveApproval, runAgent } from '../src/agent.ts';
import type { User } from '../src/data/seed.ts';
import type { ChatModel } from '../src/llm/types.ts';
import { Store } from '../src/store.ts';
import { createTools } from '../src/tools/index.ts';
import { createTicketGraph, pendingApprovals, threadConfig } from './langgraph.ts';
import { createRunner, createTicketAgent, rejectOptions, restoreState } from './openai-agents.ts';
import { startConversation, type TicketContext } from './shared.ts';

// 同一组对话分别交给三种实现，记录回答、审批内容、模型调用次数和 token。
// 三者共用 ../src 的工具、权限规则、系统提示词和离线 mock 模型，差别只在编排框架。

export interface Step {
  user: User;
  question: string;
  /** 如果这一轮需要审批，员工的决定 */
  approve?: boolean;
}

export interface Turn {
  user: string;
  question: string;
  approval?: string;
  answer: string;
}

export interface Transcript {
  turns: Turn[];
  modelCalls: number;
  inputTokens: number;
  tickets: number;
}

export type Implementation = (steps: Step[], model: ChatModel) => Promise<Transcript>;

/** 包一层计数：同一个 mock 模型，统计三种实现各调用了几次、送了多少 token */
export function metered(model: ChatModel) {
  const stats = { calls: 0, inputTokens: 0 };
  const wrapped: ChatModel = {
    name: model.name,
    async complete(request) {
      const response = await model.complete(request);
      stats.calls += 1;
      stats.inputTokens += response.usage.inputTokens;
      return response;
    },
  };
  return { model: wrapped, stats };
}

function ticketCount(store: Store, steps: Step[]) {
  return [...new Set(steps.map((step) => step.user.tenantId))].reduce((sum, tenant) => sum + store.tickets(tenant).length, 0);
}

/** 第 4–6 章的手写实现：每个问题一个 run，审批通过 resolveApproval + 再次 runAgent 继续 */
export const handRolled: Implementation = async (steps, baseModel) => {
  const store = new Store(':memory:');
  const { model, stats } = metered(baseModel);
  const options = { model, store, tools: createTools(store) };
  const turns: Turn[] = [];
  for (const step of steps) {
    const run = store.createRun(step.user, step.question);
    let status = await runAgent(run.id, step.user, options);
    let approval: string | undefined;
    if (status === 'waiting_approval') {
      const request = store.events(run.id).findLast((e) => e.type === 'approval_requested');
      if (request?.type !== 'approval_requested') throw new Error('没有找到审批请求');
      approval = request.data.summary;
      resolveApproval(store, run.id, step.user, request.data.callId, step.approve === true);
      status = await runAgent(run.id, step.user, options);
    }
    const answer = store.events(run.id).findLast((e) => e.type === 'assistant_message');
    turns.push({ user: step.user.id, question: step.question, approval, answer: answer?.type === 'assistant_message' ? answer.data.content : `（${status}）` });
  }
  return { turns, modelCalls: stats.calls, inputTokens: stats.inputTokens, tickets: ticketCount(store, steps) };
};

/** OpenAI Agents SDK：每个员工一个 Session 保存多轮历史；审批时把 RunState 序列化，模拟“隔一段时间、换一个进程”再恢复 */
export const agentsSdk: Implementation = async (steps, baseModel) => {
  const store = new Store(':memory:');
  const { model, stats } = metered(baseModel);
  const { agent, describe } = createTicketAgent(store);
  const runner = createRunner(model);
  const conversations = new Map<string, { context: TicketContext; session: MemorySession }>();
  const turns: Turn[] = [];
  for (const step of steps) {
    if (!conversations.has(step.user.id)) {
      conversations.set(step.user.id, { context: startConversation(store, step.user, 'agents-sdk'), session: new MemorySession() });
    }
    const { context, session } = conversations.get(step.user.id)!;
    let result = await runner.run(agent, step.question, { context, session });
    let approval: string | undefined;
    if (result.interruptions.length > 0) {
      approval = result.interruptions.map((item) => describe(item, context)).join('\n');
      const saved = result.state.toString();
      const state = await restoreState(agent, saved, context);
      for (const item of state.getInterruptions()) {
        if (step.approve) state.approve(item);
        else state.reject(item, rejectOptions);
      }
      result = await runner.run(agent, state, { session });
    }
    turns.push({ user: step.user.id, question: step.question, approval, answer: String(result.finalOutput ?? '') });
  }
  return { turns, modelCalls: stats.calls, inputTokens: stats.inputTokens, tickets: ticketCount(store, steps) };
};

/** LangGraph：每个员工一个线程，检查点保存多轮历史；审批时换一个新编译的图（模拟重启）再用 Command 恢复 */
export const langGraph: Implementation = async (steps, baseModel) => {
  const store = new Store(':memory:');
  const { model, stats } = metered(baseModel);
  const checkpointer = new MemorySaver();
  const threads = new Map<string, TicketContext>();
  const turns: Turn[] = [];
  for (const step of steps) {
    if (!threads.has(step.user.id)) threads.set(step.user.id, startConversation(store, step.user, 'langgraph'));
    const config = threadConfig(threads.get(step.user.id)!);
    let state = await createTicketGraph(store, model, checkpointer).invoke({ messages: [new HumanMessage(step.question)] }, config);
    let approval: string | undefined;
    const pending = await pendingApprovals(createTicketGraph(store, model, checkpointer), config);
    if (pending.length > 0) {
      approval = pending.map((request) => request.summary).join('\n');
      const decisions = Object.fromEntries(pending.map((request) => [request.callId, step.approve === true]));
      state = await createTicketGraph(store, model, checkpointer).invoke(new Command({ resume: decisions }), config);
    }
    turns.push({ user: step.user.id, question: step.question, approval, answer: state.messages.at(-1)?.text ?? '' });
  }
  return { turns, modelCalls: stats.calls, inputTokens: stats.inputTokens, tickets: ticketCount(store, steps) };
};

/** 工单编号含时间和随机数，比较回答时替换掉 */
export function normalizeAnswer(text: string): string {
  return text.replace(/TCK-[\w-]+/g, 'TCK-…');
}
