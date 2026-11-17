import { createHash } from 'node:crypto';
import { toModelMessages } from '../agent.ts';
import { estimateTokens } from '../context.ts';
import type { AgentEvent, RunStatus } from '../events.ts';
import type { Message, ToolSpec } from '../llm/types.ts';
import { looksLikeInstruction } from '../retrieval/chunk.ts';
import type { Run, Store } from '../store.ts';
import { containsPii, emptyStats, redact, type RedactionStats } from './redact.ts';

// 第 25 章：把事件日志变成监督微调（SFT）数据。
// 输出 OpenAI chat 微调格式：每行一个 {messages, tools}，assistant 的工具调用写成 tool_calls，
// 工具结果写成 role=tool 并带 tool_call_id。其他服务商和开源训练框架（TRL 等）的格式大同小异。

export interface RunRecord {
  run: Run;
  events: AgentEvent[];
}

/** 一次 run 的质量信号：员工点的赞/踩，或评测/评审给出的通过与否 */
export interface Feedback {
  runId: string;
  rating: 'up' | 'down';
  source: 'human' | 'judge';
}

export type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content?: string; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface WireTool {
  type: 'function';
  function: ToolSpec;
}

export interface SftExample {
  messages: WireMessage[];
  tools: WireTool[];
  parallel_tool_calls?: boolean;
}

export type DropReason =
  | 'tenant_opt_out'
  | 'not_completed'
  | 'negative_feedback'
  | 'no_positive_feedback'
  | 'injection'
  | 'eval_contamination'
  | 'broken_tool_pairing'
  | 'pii_residual'
  | 'too_long'
  | 'duplicate';

export interface ExportOptions {
  tools: ToolSpec[];
  /** 训练时的系统提示词必须和推理时一致。事件日志没有记录当时的提示词版本，只能按 run 重新生成 */
  systemPrompt: (run: Run) => string;
  feedback: Feedback[];
  /** 合同约定不能用于训练的租户。最先过滤，连内容都不读 */
  optOutTenants?: string[];
  /** 评测集里的问题。训练数据里出现它们，评测分数就不可信了 */
  evalQuestions?: string[];
  /** 员工目录里的姓名，用于脱敏 */
  knownNames?: string[];
  /** 验证集比例，按员工划分 */
  valFraction?: number;
  /** 单条样本的估算 token 上限 */
  maxTokens?: number;
  /** 划分用的盐。换盐 = 换一种划分；同一个盐总是得到同样的划分 */
  splitSalt?: string;
}

export interface QualityReport {
  runs: number;
  kept: number;
  dropped: Partial<Record<DropReason, number>>;
  redactions: RedactionStats;
  train: { examples: number; users: number };
  validation: { examples: number; users: number };
  /** 同时出现在训练集和验证集的员工。必须为空 */
  leakedUsers: string[];
  tokens: { min: number; p50: number; p95: number; max: number; histogram: Record<string, number> };
  toolCalls: Record<string, number>;
  /** 最终回答的类型分布。拒答样本太少，模型会学会“不知道也硬答” */
  answers: { cited: number; refusal: number; other: number };
}

export interface ExportResult {
  train: SftExample[];
  validation: SftExample[];
  report: QualityReport;
}

const allStatuses: RunStatus[] = ['running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'budget_exceeded'];

/** 读出全部顶层 run 及其事件。子 Agent 的 run 是另一段对话，需要时单独导出 */
export function loadRuns(store: Store): RunRecord[] {
  return allStatuses.flatMap((status) => store.runsWithStatus(status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((run) => ({ run, events: store.events(run.id) }));
}

export function exportSft(records: RunRecord[], options: ExportOptions): ExportResult {
  const { valFraction = 0.2, maxTokens = 4000, splitSalt = 'v1', knownNames = [] } = options;
  const tools = options.tools.map((spec): WireTool => ({ type: 'function', function: spec }));
  const redactions = emptyStats();
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (reason: DropReason) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
  const seen = new Set<string>();
  const kept: Array<{ example: SftExample; userKey: string; tokens: number }> = [];

  for (const record of records) {
    const { run, events } = record;
    const ratings = options.feedback.filter((f) => f.runId === run.id);
    const reason = governanceCheck(record, options)
      ?? (ratings.some((f) => f.rating === 'down') ? 'negative_feedback' : undefined)
      ?? (ratings.some((f) => f.rating === 'up') ? undefined : 'no_positive_feedback');
    if (reason) { drop(reason); continue; }

    const messages = toWireMessages([{ role: 'system', content: options.systemPrompt(run) }, ...toModelMessages(events)], redactions, knownNames);
    const example: SftExample = { messages, tools, ...(maxParallelCalls(messages) <= 1 ? { parallel_tool_calls: false } : {}) };
    if (validateSftExample(example).length > 0) { drop('broken_tool_pairing'); continue; }
    const line = JSON.stringify(example);
    if (containsPii(line, knownNames)) { drop('pii_residual'); continue; }
    const tokens = estimateTokens(line);
    if (tokens > maxTokens) { drop('too_long'); continue; }
    // 系统提示词里有日期，去重只看对话本身
    const key = createHash('sha256').update(JSON.stringify(messages.slice(1))).digest('hex');
    if (seen.has(key)) { drop('duplicate'); continue; }
    seen.add(key);
    kept.push({ example, userKey: `${run.tenantId}:${run.userId}`, tokens });
  }

  const isValidation = (userKey: string) => bucket(`${splitSalt}:${userKey}`) < valFraction;
  const train = kept.filter((item) => !isValidation(item.userKey));
  const validation = kept.filter((item) => isValidation(item.userKey));
  const trainUsers = new Set(train.map((item) => item.userKey));
  const validationUsers = new Set(validation.map((item) => item.userKey));
  const sorted = kept.map((item) => item.tokens).sort((a, b) => a - b);

  return {
    train: train.map((item) => item.example),
    validation: validation.map((item) => item.example),
    report: {
      runs: records.length,
      kept: kept.length,
      dropped,
      redactions,
      train: { examples: train.length, users: trainUsers.size },
      validation: { examples: validation.length, users: validationUsers.size },
      leakedUsers: [...trainUsers].filter((user) => validationUsers.has(user)),
      tokens: {
        min: sorted[0] ?? 0,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.at(-1) ?? 0,
        histogram: histogram(sorted, [500, 1000, 2000]),
      },
      toolCalls: countToolCalls(kept.map((item) => item.example)),
      answers: classifyAnswers(kept.map((item) => item.example)),
    },
  };
}

/**
 * 内部消息 → OpenAI 线上格式，同时脱敏，并把随机 id 换成每条样本内从 1 开始的编号：
 * 工具调用 id、草稿号、工单号在调用参数和工具结果里出现的地方一起替换，配对关系保持不变，去重也才有意义。
 */
export function toWireMessages(messages: Message[], stats: RedactionStats = emptyStats(), knownNames: string[] = []): WireMessage[] {
  const ids = new Map<string, string>();
  const counters = { call: 0, draft: 0, ticket: 0 };
  const stable = (raw: string, kind: keyof typeof counters, make: (n: number) => string) => {
    if (!ids.has(raw)) ids.set(raw, make(++counters[kind]));
    return ids.get(raw)!;
  };
  const callId = (raw: string) => stable(raw, 'call', (n) => `call_${n}`);
  const clean = (text: string) => redact(text
    .replace(/draft_[0-9a-f]{8}/g, (raw) => stable(raw, 'draft', (n) => `draft_${String(n).padStart(4, '0')}`))
    .replace(/TCK-[A-Z0-9]+-[0-9a-f]{4}/g, (raw) => stable(raw, 'ticket', (n) => `TCK-${String(n).padStart(4, '0')}`)), stats, knownNames);

  return messages.map((message): WireMessage => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: callId(message.toolCallId), content: clean(message.content) };
    if (message.role === 'assistant') {
      const calls = message.toolCalls ?? [];
      return {
        role: 'assistant',
        ...(message.content || calls.length === 0 ? { content: clean(message.content) } : {}),
        ...(calls.length ? { tool_calls: calls.map((call) => ({ id: callId(call.id), type: 'function' as const, function: { name: call.name, arguments: clean(call.arguments) } })) } : {}),
      };
    }
    return { role: message.role, content: clean(message.content) };
  });
}

/** 上传前的格式检查。返回空数组表示通过；服务商上传时还会再校验一次，但本地先查能省一次排队 */
export function validateSftExample(example: SftExample): string[] {
  const errors: string[] = [];
  const toolNames = new Set(example.tools.map((tool) => tool.function.name));
  let open = new Set<string>();
  const answered = new Set<string>();
  example.messages.forEach((message, index) => {
    const at = `messages[${index}]`;
    if (message.role === 'assistant') {
      if (open.size > 0) errors.push(`${at}：之前的工具调用 ${[...open].join(', ')} 没有结果`);
      open = new Set();
      if (!message.tool_calls?.length && typeof message.content !== 'string') errors.push(`${at}：assistant 既没有 content 也没有 tool_calls`);
      for (const call of message.tool_calls ?? []) {
        if (!toolNames.has(call.function.name)) errors.push(`${at}：调用了 tools 里没有的工具 ${call.function.name}`);
        try { JSON.parse(call.function.arguments); } catch { errors.push(`${at}：${call.id} 的 arguments 不是合法 JSON`); }
        if (open.has(call.id) || answered.has(call.id)) errors.push(`${at}：工具调用 id ${call.id} 重复`);
        open.add(call.id);
      }
    } else if (message.role === 'tool') {
      if (!open.has(message.tool_call_id)) errors.push(`${at}：tool 消息的 ${message.tool_call_id} 没有对应的调用`);
      open.delete(message.tool_call_id);
      answered.add(message.tool_call_id);
    } else if (typeof message.content !== 'string' || message.content.length === 0) {
      errors.push(`${at}：${message.role} 消息内容为空`);
    }
  });
  if (open.size > 0) errors.push(`工具调用 ${[...open].join(', ')} 没有结果`);
  const last = example.messages.at(-1);
  if (last?.role !== 'assistant' || last.tool_calls?.length) errors.push('最后一条必须是 assistant 的文字回答（模型要学的就是这一步）');
  if (!example.messages.some((message) => message.role === 'user')) errors.push('没有 user 消息');
  return errors;
}

/** 写成 JSONL：每行一个完整的 JSON 对象，不能有多余的换行 */
export function toJsonl(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
}

/**
 * 与质量信号无关、任何训练数据（SFT 和偏好数据）都必须先过的检查。顺序有意义：退出训练的租户最先排除，连内容都不读。
 * 返回 undefined 表示可以使用。
 */
export function governanceCheck({ run, events }: RunRecord, options: Pick<ExportOptions, 'optOutTenants' | 'evalQuestions'>): DropReason | undefined {
  if (options.optOutTenants?.includes(run.tenantId)) return 'tenant_opt_out';
  if (run.status !== 'completed') return 'not_completed';
  if (hasInjectedContent(run.question, events)) return 'injection';
  const question = normalizeQuestion(run.question);
  if (options.evalQuestions?.some((q) => normalizeQuestion(q) === question)) return 'eval_contamination';
  return undefined;
}

/** 问题里或工具结果里出现像“写给 AI 的指令”的内容：哪怕 Agent 这次没上当，也不该教模型“看过这种内容是正常的” */
function hasInjectedContent(question: string, events: AgentEvent[]): boolean {
  if (looksLikeInstruction(question)) return true;
  return events.some((event) => event.type === 'tool_finished' && looksLikeInstruction(JSON.stringify(event.data.result ?? '')));
}

function normalizeQuestion(text: string): string {
  return text.replace(/[\s，。？！,.?!]/g, '').toLowerCase();
}

function maxParallelCalls(messages: WireMessage[]): number {
  return Math.max(0, ...messages.map((message) => (message.role === 'assistant' ? message.tool_calls?.length ?? 0 : 0)));
}

/** 哈希到 [0, 1)：同一员工总是落在同一侧，新增数据也不会让老员工换边 */
function bucket(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0) / 2 ** 32;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function histogram(sorted: number[], edges: number[]): Record<string, number> {
  const labels = [...edges.map((edge, i) => `${i === 0 ? 0 : edges[i - 1]}-${edge}`), `${edges.at(-1)}+`];
  const result = Object.fromEntries(labels.map((label) => [label, 0]));
  for (const value of sorted) {
    const index = edges.findIndex((edge) => value < edge);
    result[labels[index === -1 ? labels.length - 1 : index]] += 1;
  }
  return result;
}

function countToolCalls(examples: SftExample[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const example of examples) {
    for (const message of example.messages) {
      if (message.role !== 'assistant') continue;
      for (const call of message.tool_calls ?? []) counts[call.function.name] = (counts[call.function.name] ?? 0) + 1;
    }
  }
  return counts;
}

function classifyAnswers(examples: SftExample[]): QualityReport['answers'] {
  const result = { cited: 0, refusal: 0, other: 0 };
  for (const example of examples) {
    const last = example.messages.at(-1);
    const text = last?.role === 'assistant' ? last.content ?? '' : '';
    if (/无法(确认|给出确定答案)/.test(text)) result.refusal += 1;
    else if (/\[[\w-]+@v\d+\]/.test(text)) result.cited += 1;
    else result.other += 1;
  }
  return result;
}
