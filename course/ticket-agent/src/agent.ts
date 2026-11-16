import type { User } from './data/seed.ts';
import { terminalStatuses, type AgentEvent, type RunStatus, type ToolFailure } from './events.ts';
import { ModelError } from './llm/openai.ts';
import { estimateTokens, fitContext } from './context.ts';
import type { ChatModel, Message, ToolCall } from './llm/types.ts';
import { silentLogger, type Logger } from './logger.ts';
import { systemPrompt } from './prompt.ts';
import type { Store } from './store.ts';
import { ToolError, type Tool } from './tools/types.ts';

export interface AgentOptions {
  model: ChatModel;
  store: Store;
  tools: Tool[];
  /** 一个 run 最多调用模型几次。防止模型陷入循环、无限花钱 */
  maxSteps?: number;
  /**
   * 一个 run 最多消耗多少 token。调用前检查，所以实际用量最多超出最后一次调用的输入部分；
   * 供应商不返回用量时按字符数保守估算（见 openai.ts）。
   */
  maxTokens?: number;
  /** 单次模型调用最多输出多少 token */
  maxOutputTokens?: number;
  /** 发给模型的上下文最多多少 token。超出时先清除旧的工具结果，仍放不下就结束 run（见 context.ts） */
  contextBudget?: number;
  approvalTtlMs?: number;
  onDelta?: (runId: string, text: string) => void;
  logger?: Logger;
}

/** 用这个 reason 中断 run，表示服务要重启而不是用户取消 */
export const SHUTDOWN = 'shutdown';

type Finished = Exclude<RunStatus, 'running' | 'waiting_approval'>;

/**
 * 执行（或继续执行）一个 run，直到完成、失败、取消，或需要用户审批而暂停。
 * 每一步都先写事件再继续，所以进程崩溃后再次调用本函数即可从断点恢复。
 */
export async function runAgent(runId: string, user: User, options: AgentOptions, signal = new AbortController().signal): Promise<RunStatus> {
  const { store, model, maxSteps = 8, maxTokens = 60_000, maxOutputTokens = 2_000, contextBudget = 32_000, logger = silentLogger } = options;
  const run = store.getRun(runId);
  if (!run || run.userId !== user.id || run.tenantId !== user.tenantId) throw new Error(`run ${runId} 不存在`);
  if (run.status !== 'running') return run.status;

  const tools = new Map(options.tools.map((tool) => [tool.spec.name, tool]));
  const finish = (status: Finished, reason?: string): RunStatus => {
    store.transaction(() => {
      store.append(runId, 'run_finished', { status, ...(reason ? { reason } : {}) });
      store.setStatus(runId, status);
    });
    logger.info('run finished', { runId, status, reason });
    return status;
  };

  try {
    while (true) {
      signal.throwIfAborted();
      const events = store.events(runId);
      const pending = pendingToolCalls(events);

      if (pending.length > 0) {
        // 按模型给出的顺序执行；相邻的只读调用并发执行。写操作是顺序屏障：
        // 写之后的读要看到写的结果，审批暂停时后面的调用（包括只读的）都不执行
        for (const batch of executionBatches(pending, tools)) {
          signal.throwIfAborted();
          const outcomes = await Promise.allSettled(batch.map((call) => executeToolCall(call, events, tools, user, runId, options, signal)));
          const rejected = outcomes.find((result) => result.status === 'rejected');
          if (rejected) throw rejected.reason;
          if (outcomes.some((result) => result.status === 'fulfilled' && result.value === 'paused')) {
            store.setStatus(runId, 'waiting_approval');
            return 'waiting_approval';
          }
        }
        continue;
      }

      // 兜底：最终回答已落盘但结束事件没写上（旧版本或手工修复的数据），直接结束，不再调用模型
      const lastEvent = events.at(-1);
      const lastAnswer = events.findLast((e) => e.type === 'assistant_message');
      if (lastEvent?.type === 'usage' && lastAnswer?.type === 'assistant_message' && lastAnswer.data.toolCalls.length === 0) {
        return finish('completed');
      }

      // 预算检查放在每次调用模型之前
      const steps = events.filter((event) => event.type === 'assistant_message').length;
      if (steps >= maxSteps) return finish('budget_exceeded', `超过最大步数 ${maxSteps}`);
      const used = usageOf(events);
      const remaining = maxTokens - used.inputTokens - used.outputTokens;
      if (remaining <= 0) return finish('budget_exceeded', `超过 token 预算 ${maxTokens}`);

      const toolSpecs = options.tools.map((tool) => tool.spec);
      const alreadyCleared = new Set(events.flatMap((e) => (e.type === 'context_trimmed' ? e.data.callIds : [])));
      const context = fitContext([{ role: 'system', content: systemPrompt(user) }, ...toModelMessages(events)], {
        budget: contextBudget,
        overheadTokens: estimateTokens(JSON.stringify(toolSpecs)),
        alreadyCleared,
      });
      if (!context.fits) return finish('budget_exceeded', `上下文超过 ${contextBudget} token`);
      if (context.newlyCleared.length > 0) {
        // 记下清除了哪些结果：之后几轮沿用同样的视图，直到再次超出预算
        store.append(runId, 'context_trimmed', { callIds: context.newlyCleared, tokens: context.tokens });
        logger.info('context trimmed', { runId, cleared: context.newlyCleared.length, tokens: context.tokens });
      }

      const started = Date.now();
      const response = await model.complete({
        messages: context.messages,
        tools: toolSpecs,
        // 限制单次输出，预算最多超出这一次调用的输入部分
        maxOutputTokens: Math.min(maxOutputTokens, remaining),
        signal,
        onText: (delta) => options.onDelta?.(runId, delta),
      });
      const latencyMs = Date.now() - started;
      const modelName = response.model ?? model.name;
      // 被截断的回复里，工具参数可能只生成了一半，绝不能执行
      const truncated = response.finishReason === 'length';
      const toolCalls = truncated ? [] : response.message.toolCalls ?? [];
      const final: [Finished, string?] | undefined = truncated
        ? ['failed', '模型输出被长度截断']
        : toolCalls.length === 0 ? ['completed'] : undefined;

      // 最终回答、用量和结束状态在同一个事务里提交：崩溃后要么都在，要么都不在
      store.transaction(() => {
        store.append(runId, 'assistant_message', { content: response.message.content, toolCalls });
        store.append(runId, 'usage', { model: modelName, ...response.usage, latencyMs });
        if (final) {
          store.append(runId, 'run_finished', { status: final[0], ...(final[1] ? { reason: final[1] } : {}) });
          store.setStatus(runId, final[0]);
        }
      });
      logger.info('model call', { runId, model: modelName, latencyMs, ...response.usage, toolCalls: toolCalls.map((c) => c.name) });
      if (final) {
        logger.info('run finished', { runId, status: final[0], reason: final[1] });
        return final[0];
      }
    }
  } catch (error) {
    // 服务重启引起的中断：保持 running，重启后由 recover() 接着跑
    if (signal.aborted && signal.reason === SHUTDOWN) return 'running';
    if (signal.aborted) return finish('cancelled', '用户取消');
    logger.error('run failed', { runId, error: String(error) });
    // 不把内部错误细节暴露给前端，详细信息看服务端日志
    return finish('failed', error instanceof ModelError ? `模型服务错误（${error.status}）` : '内部错误');
  }
}

async function executeToolCall(
  call: ToolCall,
  events: AgentEvent[],
  tools: Map<string, Tool>,
  user: User,
  runId: string,
  options: AgentOptions,
  signal: AbortSignal,
): Promise<'done' | 'paused'> {
  const { store, logger = silentLogger } = options;
  const fail = (error: ToolFailure) => {
    store.append(runId, 'tool_finished', { callId: call.id, name: call.name, ok: false, error });
    return 'done' as const;
  };

  const tool = tools.get(call.name);
  if (!tool) return fail({ code: 'UNKNOWN_TOOL', message: `没有名为 ${call.name} 的工具` });

  let args: unknown;
  try {
    args = tool.parse(JSON.parse(call.arguments || '{}'));
  } catch (error) {
    return fail({ code: 'INVALID_ARGUMENTS', message: error instanceof ToolError ? error.message : '参数不是合法 JSON' });
  }

  const context = { user, runId, callId: call.id, signal };
  if (tool.requiresApproval) {
    const decision = events.find((e) => e.type === 'approval_resolved' && e.data.callId === call.id);
    if (!decision) {
      const requested = events.some((e) => e.type === 'approval_requested' && e.data.callId === call.id);
      if (!requested) {
        store.append(runId, 'approval_requested', {
          callId: call.id,
          name: call.name,
          args,
          summary: tool.describe?.(args, context) ?? `${call.name} ${call.arguments}`,
          expiresAt: new Date(Date.now() + (options.approvalTtlMs ?? 30 * 60_000)).toISOString(),
        });
      }
      return 'paused';
    }
    if (decision.type === 'approval_resolved' && !decision.data.approved) {
      return fail(decision.data.reason === 'expired'
        ? { code: 'APPROVAL_EXPIRED', message: '确认已超时，操作未执行' }
        : { code: 'APPROVAL_REJECTED', message: '员工拒绝了这个操作，操作未执行' });
    }
  }

  signal.throwIfAborted();
  store.append(runId, 'tool_started', { callId: call.id, name: call.name, args });
  const started = Date.now();
  try {
    const result = await tool.run(args, context);
    store.append(runId, 'tool_finished', { callId: call.id, name: call.name, ok: true, result });
    logger.info('tool call', { runId, tool: call.name, ok: true, latencyMs: Date.now() - started });
  } catch (error) {
    if (signal.aborted) throw error;
    logger.error('tool call', { runId, tool: call.name, ok: false, error: String(error) });
    fail(error instanceof ToolError
      ? { code: error.code, message: error.message }
      : { code: 'INTERNAL_ERROR', message: '工具执行失败，请稍后再试' });
  }
  return 'done';
}

/** 把待执行的调用切成批次：相邻的只读调用合成一批并发执行，其余每个调用单独一批 */
function executionBatches(calls: ToolCall[], tools: Map<string, Tool>): ToolCall[][] {
  const batches: ToolCall[][] = [];
  for (const call of calls) {
    const last = batches.at(-1);
    const readOnly = tools.get(call.name)?.readOnly === true;
    if (readOnly && last && tools.get(last[0].name)?.readOnly === true) last.push(call);
    else batches.push([call]);
  }
  return batches;
}

/** 最后一条模型消息中，还没有结果的工具调用（包括崩溃时执行到一半的） */
function pendingToolCalls(events: AgentEvent[]): ToolCall[] {
  const last = events.findLast((event) => event.type === 'assistant_message');
  if (!last || last.type !== 'assistant_message') return [];
  const finished = new Set(events.flatMap((e) => (e.type === 'tool_finished' ? [e.data.callId] : [])));
  return last.data.toolCalls.filter((call) => !finished.has(call.id));
}

/**
 * 从事件日志重建发给模型的对话历史。
 * 并发执行的工具完成顺序不固定，这里按模型给出调用的顺序排列结果，保证同样的日志总是得到同样的消息（利于缓存和回放）。
 */
export function toModelMessages(events: AgentEvent[]): Message[] {
  const messages: Message[] = [];
  let order = new Map<string, number>();
  let results: Array<{ index: number; message: Message }> = [];
  const flush = () => {
    results.sort((a, b) => a.index - b.index).forEach((result) => messages.push(result.message));
    results = [];
  };
  for (const event of events) {
    if (event.type === 'run_started') {
      flush();
      messages.push({ role: 'user', content: event.data.question });
    }
    if (event.type === 'assistant_message') {
      flush();
      order = new Map(event.data.toolCalls.map((call, index) => [call.id, index]));
      messages.push({ role: 'assistant', content: event.data.content, ...(event.data.toolCalls.length ? { toolCalls: event.data.toolCalls } : {}) });
    }
    if (event.type === 'tool_finished') {
      const payload = event.data.ok ? { ok: true, data: event.data.result } : { ok: false, error: event.data.error };
      results.push({ index: order.get(event.data.callId) ?? order.size, message: { role: 'tool', toolCallId: event.data.callId, content: JSON.stringify(payload) } });
    }
  }
  flush();
  return messages;
}

export function usageOf(events: AgentEvent[]) {
  const total = { inputTokens: 0, outputTokens: 0, latencyMs: 0, modelCalls: 0 };
  for (const event of events) {
    if (event.type !== 'usage') continue;
    total.inputTokens += event.data.inputTokens;
    total.outputTokens += event.data.outputTokens;
    total.latencyMs += event.data.latencyMs;
    total.modelCalls += 1;
  }
  return total;
}

export function estimateCost(usage: { inputTokens: number; outputTokens: number }, prices: { input: number; output: number }) {
  return (usage.inputTokens * prices.input + usage.outputTokens * prices.output) / 1_000_000;
}

export type ApprovalResult = { ok: true; approved: boolean } | { ok: false; code: 'NOT_FOUND' | 'NOT_WAITING' | 'ALREADY_RESOLVED' };

/** 记录用户的审批决定。只有 run 的发起人能审批；过期的审批按拒绝处理 */
export function resolveApproval(store: Store, runId: string, user: User, callId: string, approved: boolean, now = new Date()): ApprovalResult {
  const run = store.getRun(runId);
  if (!run || run.userId !== user.id || run.tenantId !== user.tenantId) return { ok: false, code: 'NOT_FOUND' };
  if (run.status !== 'waiting_approval') return { ok: false, code: 'NOT_WAITING' };
  const events = store.events(runId);
  const request = events.find((e) => e.type === 'approval_requested' && e.data.callId === callId);
  if (!request || request.type !== 'approval_requested') return { ok: false, code: 'NOT_FOUND' };
  if (events.some((e) => e.type === 'approval_resolved' && e.data.callId === callId)) return { ok: false, code: 'ALREADY_RESOLVED' };

  const expired = now.getTime() > Date.parse(request.data.expiresAt);
  const finalDecision = approved && !expired;
  store.transaction(() => {
    store.append(runId, 'approval_resolved', { callId, approved: finalDecision, userId: user.id, ...(expired ? { reason: 'expired' as const } : {}) });
    store.setStatus(runId, 'running');
  });
  return { ok: true, approved: finalDecision };
}

/** 取消一个没有在执行中的 run（例如正在等待审批） */
export function cancelIdleRun(store: Store, runId: string): boolean {
  const run = store.getRun(runId);
  if (!run || terminalStatuses.includes(run.status)) return false;
  store.transaction(() => {
    store.append(runId, 'run_finished', { status: 'cancelled', reason: '用户取消' });
    store.setStatus(runId, 'cancelled');
  });
  return true;
}
