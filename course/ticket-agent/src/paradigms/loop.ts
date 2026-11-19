// 第 28 章：Agent Loop 范式的“内核”。
// 它只做一件事：问模型 → 执行模型要的工具 → 把结果放回对话 → 再问，直到模型不再要工具。
// 预算、审批、错误信封、检查点、上下文裁剪都不在这里，而是通过 hooks 从外面接进来——
// 那一圈就是 harness（见 harness.ts）。不传 hooks 时，它就是最朴素的 Agent Loop。
import type { User } from '../data/seed.ts';
import type { ChatModel, Message, ToolCall } from '../llm/types.ts';
import type { Tool } from '../tools/types.ts';

/** 循环的全部状态。只有数据，没有函数和连接，所以能 JSON 序列化、存起来、在另一个进程里接着跑 */
export interface LoopState {
  messages: Message[];
  /** 已经调用了几次模型 */
  steps: number;
  usage: { inputTokens: number; outputTokens: number };
}

export type LoopOutcome =
  | { status: 'completed'; answer: string }
  | { status: 'paused'; call: ToolCall; summary: string }
  | { status: 'stopped'; reason: string };

/** 工具执行前的决定：照常执行、不执行而直接给出结果（拒绝、策略拦截），或暂停等人 */
export type ToolDecision = { action: 'run' } | { action: 'skip'; result: unknown } | { action: 'pause'; summary: string };

/** Harness 的接入点。全部可选；一个都不传，内核就是“裸循环” */
export interface LoopHooks {
  /** 每次调用模型之前：返回 stop 就结束（预算、死循环检测）；返回 messages 就用它代替完整历史发给模型（上下文裁剪） */
  beforeModel?(state: Readonly<LoopState>): { stop: string } | { messages: Message[] } | undefined;
  beforeTool?(call: ToolCall, state: Readonly<LoopState>): ToolDecision;
  /** 工具抛错时转换成交给模型的结果。不提供时异常直接抛出，整个 run 失败 */
  onToolError?(call: ToolCall, error: unknown): unknown;
  /** state 每变化一次就调用一次：持久化检查点 */
  checkpoint?(state: Readonly<LoopState>): void;
}

export interface LoopDeps {
  model: ChatModel;
  tools: Tool[];
  user: User;
  runId: string;
  hooks?: LoopHooks;
  /** 保险丝，不是策略：防止测试里的失控模型把机器跑挂。真正的预算由 harness 决定 */
  fuse?: number;
  signal?: AbortSignal;
}

export function newLoopState(system: string, question: string): LoopState {
  return {
    messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
    steps: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/** 运行（或继续运行）循环。会原地修改 state；从检查点恢复时把读出来的 state 传进来即可 */
export async function agentLoop(state: LoopState, deps: LoopDeps): Promise<LoopOutcome> {
  const { model, tools, user, runId, hooks = {}, fuse = 100, signal = new AbortController().signal } = deps;
  const byName = new Map(tools.map((tool) => [tool.spec.name, tool]));

  while (true) {
    // 1. 先执行上一条模型消息里还没有结果的工具调用。正常情况下是刚要的；从检查点恢复时是崩溃前没做完的
    for (const call of pendingCalls(state.messages)) {
      signal.throwIfAborted();
      const decision = hooks.beforeTool?.(call, state) ?? { action: 'run' };
      if (decision.action === 'pause') return { status: 'paused', call, summary: decision.summary };
      let result: unknown;
      if (decision.action === 'skip') {
        result = decision.result;
      } else {
        try {
          result = { ok: true, data: await runTool(byName, call, { user, runId, callId: call.id, signal }) };
        } catch (error) {
          if (!hooks.onToolError || signal.aborted) throw error;
          result = hooks.onToolError(call, error);
        }
      }
      state.messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
      hooks.checkpoint?.(state);
    }

    // 2. 再问模型
    if (state.steps >= fuse) throw new Error(`保险丝熔断：模型已经调用了 ${fuse} 次`);
    const prepared = hooks.beforeModel?.(state);
    if (prepared && 'stop' in prepared) return { status: 'stopped', reason: prepared.stop };
    const response = await model.complete({
      messages: prepared?.messages ?? state.messages,
      tools: tools.map((tool) => tool.spec),
      signal,
    });
    state.steps += 1;
    state.usage.inputTokens += response.usage.inputTokens;
    state.usage.outputTokens += response.usage.outputTokens;
    state.messages.push(response.message);
    hooks.checkpoint?.(state);

    // 3. 模型不再要工具，就是它认为做完了。“什么时候结束”由模型决定，这是 Agent Loop 的本质
    if (!response.message.toolCalls?.length) return { status: 'completed', answer: response.message.content };
  }
}

/** 内核不知道审批、不知道权限，也不把错误包装给模型：工具名不对、参数不对都直接抛出 */
async function runTool(tools: Map<string, Tool>, call: ToolCall, context: Parameters<Tool['run']>[1]): Promise<unknown> {
  const tool = tools.get(call.name);
  if (!tool) throw new Error(`没有名为 ${call.name} 的工具`);
  return tool.run(tool.parse(JSON.parse(call.arguments || '{}')), context);
}

/** 最后一条模型消息里，还没有对应 tool 消息的调用 */
export function pendingCalls(messages: Message[]): ToolCall[] {
  const index = messages.findLastIndex((message) => message.role === 'assistant');
  const last = messages[index];
  if (!last || last.role !== 'assistant' || !last.toolCalls) return [];
  const done = new Set(messages.slice(index + 1).flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : [])));
  return last.toolCalls.filter((call) => !done.has(call.id));
}
