import type { User } from './data/seed.ts';
import { terminalStatuses, type AgentEvent, type RunStatus, type ToolFailure } from './events.ts';
import { ModelError } from './llm/openai.ts';
import { estimateTokens, fitContext } from './context.ts';
import type { ChatModel, Message, ModelRequest, ToolCall } from './llm/types.ts';
import { silentLogger, type Logger } from './logger.ts';
import { BLOCKED_INPUT_REPLY, type Guardrails } from './guardrails/index.ts';
import { formatMemories, type Memory } from './memory.ts';
import { systemPrompt } from './prompt.ts';
import type { Store } from './store.ts';
import { activeTelemetry, type AgentTelemetry } from './telemetry/genai.ts';
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
  /** 替换默认的系统提示词。子 Agent 用它换成自己的角色说明（第 19 章） */
  systemPrompt?: (user: User) => string;
  /** 长期记忆（第 19 章）。缺省不启用：不注入任何记忆，行为与前面章节完全一致 */
  memory?: Pick<Memory, 'recall'>;
  /** 第 22 章：OpenTelemetry 追踪。缺省时沿用当前上下文里的（子 Agent 靠它挂到父 run 的 trace 上），都没有就不追踪 */
  telemetry?: AgentTelemetry;
  /** 第 21 章：输入检查、工具调用策略、工具结果筛查、输出过滤。缺省不启用 */
  guardrails?: Guardrails;
}

/** 用这个 reason 中断 run，表示服务要重启而不是用户取消 */
export const SHUTDOWN = 'shutdown';

type Finished = Exclude<RunStatus, 'running' | 'waiting_approval'>;

/**
 * 执行（或继续执行）一个 run，直到完成、失败、取消，或需要用户审批而暂停。
 * 每一步都先写事件再继续，所以进程崩溃后再次调用本函数即可从断点恢复。
 */
export async function runAgent(runId: string, user: User, options: AgentOptions, signal = new AbortController().signal): Promise<RunStatus> {
  const telemetry = options.telemetry ?? activeTelemetry();
  if (!telemetry) return runLoop(runId, user, options, signal);
  return telemetry.run({ runId, user, store: options.store, model: options.model.name }, () => runLoop(runId, user, { ...options, telemetry }, signal));
}

async function runLoop(runId: string, user: User, options: AgentOptions, signal: AbortSignal): Promise<RunStatus> {
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

      // 第 21 章：输入检查只在第一次调用模型之前做；拦下时一次模型调用也不发生
      const inputBlock = options.guardrails && !events.some((e) => e.type === 'assistant_message') ? options.guardrails.checkInput(run.question) : undefined;
      if (inputBlock) {
        store.transaction(() => {
          store.append(runId, 'guardrail', inputBlock);
          store.append(runId, 'assistant_message', { content: BLOCKED_INPUT_REPLY, toolCalls: [] });
          store.append(runId, 'run_finished', { status: 'completed' });
          store.setStatus(runId, 'completed');
        });
        logger.info('guardrail', { runId, stage: 'input', rule: inputBlock.rule });
        return 'completed';
      }

      // 记忆只在 run 开始时取一次并写进日志：之后每一轮、回放和崩溃恢复看到的都是同一份
      if (options.memory && !events.some((e) => e.type === 'memory_recalled' || e.type === 'assistant_message')) {
        const recalled = options.memory.recall(user);
        store.append(runId, 'memory_recalled', recalled);
        logger.info('memory recalled', { runId, items: recalled.items.length, dropped: recalled.dropped });
        continue;
      }

      const pending = pendingToolCalls(events);

      if (pending.length > 0) {
        // 按模型给出的顺序执行；相邻的只读调用并发执行。写操作是顺序屏障：
        // 写之后的读要看到写的结果，审批暂停时后面的调用（包括只读的）都不执行
        for (const batch of executionBatches(pending, tools)) {
          signal.throwIfAborted();
          const outcomes = await Promise.allSettled(batch.map((call) => {
            const execute = () => executeToolCall(call, events, tools, user, runId, options, signal);
            return options.telemetry ? options.telemetry.tool(call, { runId, store }, execute) : execute();
          }));
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
      const prompt = (options.systemPrompt?.(user) ?? systemPrompt(user, new Date(), [...tools.keys()])) + (options.guardrails?.promptSuffix ?? '');
      const context = fitContext([{ role: 'system', content: prompt }, ...toModelMessages(events)], {
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
      const request: ModelRequest = {
        messages: context.messages,
        tools: toolSpecs,
        // 限制单次输出，预算最多超出这一次调用的输入部分
        maxOutputTokens: Math.min(maxOutputTokens, remaining),
        signal,
        // 开启护栏时不逐字推送：回答要先过输出检查，检查后再一次性推送，否则被拦下的内容已经到了浏览器
        onText: options.guardrails ? undefined : (delta) => options.onDelta?.(runId, delta),
      };
      const response = options.telemetry
        ? await options.telemetry.chat(model.name, request, (traced) => model.complete(traced))
        : await model.complete(request);
      const latencyMs = Date.now() - started;
      const modelName = response.model ?? model.name;
      // 被截断的回复里，工具参数可能只生成了一半，绝不能执行
      const truncated = response.finishReason === 'length';
      const toolCalls = truncated ? [] : response.message.toolCalls ?? [];
      const final: [Finished, string?] | undefined = truncated
        ? ['failed', '模型输出被长度截断']
        : toolCalls.length === 0 ? ['completed'] : undefined;
      const output = options.guardrails?.checkOutput(response.message.content, prompt);
      const content = output?.text ?? response.message.content;
      if (output && content) options.onDelta?.(runId, content);

      // 最终回答、用量和结束状态在同一个事务里提交：崩溃后要么都在，要么都不在
      store.transaction(() => {
        output?.findings.forEach((finding) => store.append(runId, 'guardrail', finding));
        store.append(runId, 'assistant_message', { content, toolCalls });
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
  let raw: unknown;
  try {
    raw = JSON.parse(call.arguments || '{}');
    args = tool.parse(raw);
  } catch (error) {
    return fail({ code: 'INVALID_ARGUMENTS', message: error instanceof ToolError ? error.message : '参数不是合法 JSON' });
  }

  // 第 21 章：策略检查在审批之前。违反策略的调用不去打扰员工，直接以错误结果返回给模型
  const runStarted = events.find((e) => e.type === 'run_started');
  const question = runStarted?.type === 'run_started' ? runStarted.data.question : '';
  const blocked = options.guardrails?.checkToolCall({ call, tool, raw }, { user, question, events });
  if (blocked) {
    logger.info('guardrail', { runId, stage: 'tool_call', rule: blocked.rule, tool: call.name });
    return store.transaction(() => {
      store.append(runId, 'guardrail', blocked);
      return fail({ code: 'GUARDRAIL_BLOCKED', message: `安全策略拒绝了这次调用：${blocked.detail}` });
    });
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
    const screened = options.guardrails?.screenToolResult(call.name, call.id, result);
    if (screened?.findings.length) {
      store.transaction(() => {
        screened.findings.forEach((finding) => store.append(runId, 'guardrail', finding));
        store.append(runId, 'tool_finished', { callId: call.id, name: call.name, ok: true, result: screened.result });
      });
    } else {
      store.append(runId, 'tool_finished', { callId: call.id, name: call.name, ok: true, result });
    }
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
  let questionIndex = -1;
  const flush = () => {
    results.sort((a, b) => a.index - b.index).forEach((result) => messages.push(result.message));
    results = [];
  };
  for (const event of events) {
    if (event.type === 'run_started') {
      flush();
      questionIndex = messages.length;
      messages.push({ role: 'user', content: event.data.question });
    }
    // 记忆放在问题之前、以 user 角色出现：它来自员工本人，权限不高于员工，绝不放进系统提示词
    if (event.type === 'memory_recalled' && event.data.items.length > 0 && questionIndex >= 0) {
      messages.splice(questionIndex, 0, { role: 'user', content: formatMemories(event.data.items) });
      questionIndex += 1;
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
