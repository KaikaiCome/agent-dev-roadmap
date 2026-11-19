// 第 28 章：Harness —— 包在 Agent Loop 外面的那一圈工程。
// 内核（loop.ts）只负责“问模型、跑工具”；这里决定：最多跑多久、花多少钱、看到什么上下文、
// 哪些工具要先问人、工具出错时模型看到什么、状态存在哪里、崩溃后从哪里接着跑、恢复时信任谁的身份。
// 每一项都对应 src/agent.ts 里的生产实现，本文件把它们从循环里拆出来，方便逐项打开、关闭和测试。
import { estimateTokens, fitContext } from '../context.ts';
import type { User } from '../data/seed.ts';
import type { ChatModel, Message, ToolCall } from '../llm/types.ts';
import { systemPrompt } from '../prompt.ts';
import { ToolError, type Tool } from '../tools/types.ts';
import { agentLoop, newLoopState, type LoopHooks, type LoopState } from './loop.ts';

export interface HarnessPolicy {
  /** 一个 run 最多调用模型几次 */
  maxSteps?: number;
  /** 一个 run 最多消耗多少 token（输入 + 输出） */
  maxTokens?: number;
  /** 同一个工具、同样的参数出现这么多次就判定为原地打转 */
  maxRepeats?: number;
  /** 发给模型的上下文上限，超出时先清除旧的工具结果（第 13 章的 fitContext） */
  contextBudget?: number;
}

export type HarnessStatus = 'running' | 'waiting_approval' | 'completed' | 'stopped';

/** 一个 run 的检查点：循环状态 + harness 自己的状态（审批决定、已清除的上下文）+ 归属 */
export interface RunRecord {
  runId: string;
  tenantId: string;
  userId: string;
  status: HarnessStatus;
  state: LoopState;
  /** callId → 员工的决定。它属于 harness，不属于对话，所以不放进 messages */
  decisions: Record<string, boolean>;
  /** 已经从上下文里清除的工具调用。之后保持清除，发给模型的前缀才稳定（利于提示词缓存） */
  cleared: string[];
  pending?: { callId: string; name: string; summary: string };
  answer?: string;
  reason?: string;
}

export interface Checkpointer {
  load(runId: string): RunRecord | undefined;
  save(record: RunRecord): void;
}

/** 存字符串而不是对象引用：和真实数据库一样，每次读出来都是一份新拷贝，不会被内存里的修改“顺便”改掉 */
export class MemoryCheckpointer implements Checkpointer {
  #rows = new Map<string, string>();
  saves = 0;
  /** 测试用：返回 true 时模拟“进程在写检查点之前死掉” */
  crashBeforeSave?: (record: RunRecord) => boolean;

  load(runId: string): RunRecord | undefined {
    const raw = this.#rows.get(runId);
    return raw ? JSON.parse(raw) : undefined;
  }

  save(record: RunRecord) {
    if (this.crashBeforeSave?.(record)) throw new Error('模拟崩溃：检查点没有写入');
    this.#rows.set(record.runId, JSON.stringify(record));
    this.saves += 1;
  }
}

export interface HarnessDeps {
  model: ChatModel;
  tools: Tool[];
  checkpointer: Checkpointer;
  policy?: HarnessPolicy;
  /** 缺省用参考项目的系统提示词 */
  systemPrompt?: (user: User) => string;
}

export class Harness {
  #deps: HarnessDeps;

  constructor(deps: HarnessDeps) {
    this.#deps = deps;
  }

  async start(runId: string, user: User, question: string): Promise<RunRecord> {
    if (this.#deps.checkpointer.load(runId)) throw new Error(`run ${runId} 已存在，请用 resume`);
    const toolNames = this.#deps.tools.map((tool) => tool.spec.name);
    const prompt = this.#deps.systemPrompt?.(user) ?? systemPrompt(user, new Date(), toolNames);
    const record: RunRecord = {
      runId,
      tenantId: user.tenantId,
      userId: user.id,
      status: 'running',
      state: newLoopState(prompt, question),
      decisions: {},
      cleared: [],
    };
    this.#deps.checkpointer.save(record);
    return this.#drive(record, user);
  }

  /** 审批之后、或进程重启之后调用。身份由调用方（登录会话）给出，检查点里存的 userId 只用来比对，不用来代替 */
  async resume(runId: string, user: User, signal?: AbortSignal): Promise<RunRecord> {
    const record = this.#own(runId, user);
    // 已经结束或还在等审批：什么都不做。重复调用 resume 是安全的
    if (record.status !== 'running') return record;
    return this.#drive(record, user, signal);
  }

  decide(runId: string, user: User, callId: string, approved: boolean): RunRecord {
    const record = this.#own(runId, user);
    if (record.status !== 'waiting_approval' || record.pending?.callId !== callId) throw new Error('没有等待这次调用的审批');
    record.decisions[callId] = approved;
    record.status = 'running';
    delete record.pending;
    this.#deps.checkpointer.save(record);
    return record;
  }

  #own(runId: string, user: User): RunRecord {
    const record = this.#deps.checkpointer.load(runId);
    if (!record || record.tenantId !== user.tenantId || record.userId !== user.id) throw new Error(`run ${runId} 不存在`);
    return record;
  }

  // 异常不在这里捕获：异常就当作“进程在这里死掉”，存储里留下的是最后一个检查点，resume 从那里继续。
  // 生产版（src/agent.ts）会把能判定的错误（用户取消、模型服务 4xx）记成 failed / cancelled，见第 4、15 章
  async #drive(record: RunRecord, user: User, signal?: AbortSignal): Promise<RunRecord> {
    const outcome = await agentLoop(record.state, {
      model: this.#deps.model,
      tools: this.#deps.tools,
      user,
      runId: record.runId,
      hooks: this.#hooks(record, user),
      signal,
    });
    if (outcome.status === 'completed') {
      record.status = 'completed';
      record.answer = outcome.answer;
    } else if (outcome.status === 'paused') {
      record.status = 'waiting_approval';
      record.pending = { callId: outcome.call.id, name: outcome.call.name, summary: outcome.summary };
    } else {
      record.status = 'stopped';
      record.reason = outcome.reason;
    }
    this.#deps.checkpointer.save(record);
    return record;
  }

  #hooks(record: RunRecord, user: User): LoopHooks {
    const { maxSteps = 8, maxTokens = 60_000, maxRepeats = 3, contextBudget = 32_000 } = this.#deps.policy ?? {};
    const tools = new Map(this.#deps.tools.map((tool) => [tool.spec.name, tool]));
    const specTokens = estimateTokens(JSON.stringify(this.#deps.tools.map((tool) => tool.spec)));

    return {
      // 预算、死循环检测和上下文裁剪都放在“调用模型之前”：这是唯一一个还没花钱的时刻
      beforeModel: (state) => {
        if (state.steps >= maxSteps) return { stop: `超过最大步数 ${maxSteps}` };
        const used = state.usage.inputTokens + state.usage.outputTokens;
        if (used >= maxTokens) return { stop: `超过 token 预算 ${maxTokens}（已用 ${used}）` };
        const repeated = mostRepeatedCall(state.messages);
        if (repeated && repeated.count >= maxRepeats) return { stop: `同一个调用重复了 ${repeated.count} 次：${repeated.name}` };

        const context = fitContext(state.messages, { budget: contextBudget, overheadTokens: specTokens, alreadyCleared: new Set(record.cleared) });
        if (!context.fits) return { stop: `上下文超过 ${contextBudget} token` };
        record.cleared.push(...context.newlyCleared);
        return { messages: context.messages };
      },

      // 审批是 harness 的策略，不是工具的行为：内核看不到 requiresApproval，是这里读它
      beforeTool: (call) => {
        const tool = tools.get(call.name);
        if (!tool) return { action: 'skip', result: failure('UNKNOWN_TOOL', `没有名为 ${call.name} 的工具`) };
        if (!tool.requiresApproval) return { action: 'run' };
        const decision = record.decisions[call.id];
        if (decision === true) return { action: 'run' };
        if (decision === false) return { action: 'skip', result: failure('APPROVAL_REJECTED', '员工拒绝了这个操作，操作未执行') };
        let args: unknown;
        try {
          args = tool.parse(JSON.parse(call.arguments || '{}'));
        } catch (error) {
          // 参数都不合法的写操作，不去打扰员工，直接让模型改
          return { action: 'skip', result: toFailure(error) };
        }
        const context = { user, runId: record.runId, callId: call.id, signal: new AbortController().signal };
        return { action: 'pause', summary: tool.describe?.(args, context) ?? `${call.name} ${call.arguments}` };
      },

      // 错误变成结构化结果交给模型，让它有机会自己纠正；内部错误的细节不给模型看
      onToolError: (_call, error) => toFailure(error),

      checkpoint: () => this.#deps.checkpointer.save(record),
    };
  }
}

function failure(code: string, message: string) {
  return { ok: false, error: { code, message } };
}

function toFailure(error: unknown) {
  if (error instanceof ToolError) return failure(error.code, error.message);
  if (error instanceof SyntaxError) return failure('INVALID_ARGUMENTS', '参数不是合法 JSON');
  return failure('INTERNAL_ERROR', '工具执行失败，请稍后再试');
}

/** 整个 run 里，工具名 + 参数完全相同的调用出现了几次（取最多的那个） */
export function mostRepeatedCall(messages: Message[]): { name: string; count: number } | undefined {
  const counts = new Map<string, { call: ToolCall; count: number }>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      const key = `${call.name}\u0000${call.arguments}`;
      const entry = counts.get(key) ?? { call, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  let top: { call: ToolCall; count: number } | undefined;
  for (const entry of counts.values()) if (!top || entry.count > top.count) top = entry;
  return top && { name: top.call.name, count: top.count };
}
