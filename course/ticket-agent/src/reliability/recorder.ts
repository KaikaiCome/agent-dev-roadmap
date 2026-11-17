import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AssistantMessage, ChatModel, Message, ModelRequest, ModelResponse, Usage } from '../llm/types.ts';

// 第 24 章：录制回放。录制模式把每次“请求 → 回复”存进 JSON 文件；回放模式按请求的哈希取出回复，不访问模型。
// 真实模型跑一次录下来，CI 里回放：结果完全确定、零费用、不需要密钥。
// 请求变了（提示词、工具定义、上一步的结果）就找不到录音，此时必须报错而不是“随便给一个”，
// 否则 CI 绿着，测的却是旧行为。

/** 每次运行都会变、但不影响模型决策的值：草稿号、工单号、日期、UUID。哈希前替换成占位符 */
export const defaultVolatile: RegExp[] = [
  /draft_[0-9a-f]{8}/g,
  /TCK-[0-9A-Z]+-[0-9a-f]{4}/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
];

export interface FixtureEntry {
  key: string;
  /** 每条消息规范化后的 “角色:短哈希”，未命中时用来定位第一处不同 */
  messages: string[];
  /** 最后一条消息的开头（已脱敏），方便人看 */
  preview: string;
  response: { message: AssistantMessage; usage: Usage; finishReason: string };
}

export interface Fixture {
  version: 1;
  model: string;
  recordedAt: string;
  note?: string;
  entries: FixtureEntry[];
}

export interface Normalized {
  key: string;
  messageHashes: string[];
  /** 真实值 → 占位符 */
  values: Map<string, string>;
}

export function normalizeRequest(request: ModelRequest, volatile = defaultVolatile): Normalized {
  const values = new Map<string, string>();
  const callIds = new Map<string, string>();
  const callId = (raw: string) => callIds.get(raw) ?? callIds.set(raw, `<call_${callIds.size + 1}>`).get(raw)!;
  const scrub = (text: string) => volatile.reduce((result, pattern) => result.replace(pattern, (match) => values.get(match) ?? values.set(match, `<v${values.size + 1}>`).get(match)!), text);
  // 工具调用 id 由模型随机生成（call_xxx、mock_17），按出现顺序编号；参数和结果里的易变值换成占位符
  const messages = request.messages.map((message): unknown => {
    switch (message.role) {
      case 'assistant':
        return { role: 'assistant', content: scrub(message.content), toolCalls: (message.toolCalls ?? []).map((call) => ({ id: callId(call.id), name: call.name, arguments: scrub(call.arguments) })) };
      case 'tool':
        return { role: 'tool', toolCallId: callId(message.toolCallId), content: scrub(message.content) };
      default:
        return { role: message.role, content: scrub(message.content) };
    }
  });
  // 工具定义和输出格式也是请求的一部分：改了工具描述，模型的行为就可能变，录音必须作废
  const key = hash({ messages, tools: request.tools ?? [], responseFormat: request.responseFormat ?? null });
  const messageHashes = messages.map((message, i) => `${request.messages[i].role}:${hash(message).slice(0, 8)}`);
  return { key, messageHashes, values };
}

/** 去掉可能混进录音的密钥。录音文件要提交到仓库，宁可多删 */
export function redactSecrets(text: string, secrets: string[] = []): string {
  let result = text
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer ***')
    .replace(/\b(api[_-]?key|access[_-]?token|secret)(["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1$2***');
  for (const secret of secrets) if (secret) result = result.split(secret).join('***');
  return result;
}

export interface RecordingModel extends ChatModel {
  fixture(): Fixture;
  save(path: string): void;
}

export function createRecordingModel(inner: ChatModel, options: { secrets?: string[]; note?: string; volatile?: RegExp[] } = {}): RecordingModel {
  const entries: FixtureEntry[] = [];
  const secrets = options.secrets ?? [];
  const fixture = (): Fixture => ({ version: 1, model: inner.name, recordedAt: new Date().toISOString(), ...(options.note ? { note: options.note } : {}), entries });
  return {
    name: inner.name,
    fixture,
    save(path) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(fixture(), null, 1) + '\n');
    },
    async complete(request) {
      const response = await inner.complete(request);
      const { key, messageHashes, values } = normalizeRequest(request, options.volatile);
      // 回复里引用了请求中的易变值（例如 create_ticket 的 draftId），存成占位符，回放时换回当次的真实值
      const template = (text: string) => redactSecrets([...values].reduce((result, [value, placeholder]) => result.split(value).join(placeholder), text), secrets);
      const message: AssistantMessage = {
        role: 'assistant',
        content: template(response.message.content),
        ...(response.message.toolCalls?.length ? { toolCalls: response.message.toolCalls.map((call) => ({ ...call, arguments: template(call.arguments) })) } : {}),
      };
      entries.push({
        key,
        messages: messageHashes,
        preview: redactSecrets(request.messages.at(-1)?.content.slice(0, 80) ?? '', secrets),
        response: { message, usage: response.usage, finishReason: response.finishReason },
      });
      return response;
    },
  };
}

export class ReplayMissError extends Error {
  readonly key: string;
  constructor(message: string, key: string) {
    super(message);
    this.name = 'ReplayMissError';
    this.key = key;
  }
}

export interface ReplayModel extends ChatModel {
  /** 未命中的请求。Agent 会把模型异常记成 run 失败，所以调用方必须在最后检查它，并让进程失败 */
  readonly misses: ReplayMissError[];
  /** 还没被用到的录音条数。不为 0 说明这次运行比录制时少调用了模型，同样是行为变化 */
  unused(): number;
}

export function createReplayModel(fixture: Fixture, options: { volatile?: RegExp[] } = {}): ReplayModel {
  if (fixture.version !== 1) throw new Error(`不支持的录音版本 ${fixture.version}`);
  const queues = new Map<string, FixtureEntry[]>();
  for (const entry of fixture.entries) queues.set(entry.key, [...(queues.get(entry.key) ?? []), entry]);
  const misses: ReplayMissError[] = [];
  return {
    name: fixture.model,
    misses,
    unused: () => [...queues.values()].reduce((sum, queue) => sum + queue.length, 0),
    async complete(request): Promise<ModelResponse> {
      request.signal?.throwIfAborted();
      const { key, messageHashes, values } = normalizeRequest(request, options.volatile);
      const entry = queues.get(key)?.shift();
      if (!entry) {
        const error = new ReplayMissError(describeMiss(fixture, key, messageHashes, request.messages), key);
        misses.push(error);
        throw error;
      }
      const placeholders = new Map([...values].map(([value, placeholder]) => [placeholder, value]));
      const fill = (text: string) => text.replace(/<v\d+>/g, (placeholder) => placeholders.get(placeholder) ?? placeholder);
      const { message, usage, finishReason } = entry.response;
      const replayed: AssistantMessage = {
        role: 'assistant',
        content: fill(message.content),
        ...(message.toolCalls?.length ? { toolCalls: message.toolCalls.map((call) => ({ ...call, arguments: fill(call.arguments) })) } : {}),
      };
      if (replayed.content) request.onText?.(replayed.content);
      return { message: replayed, usage: { ...usage }, finishReason, model: fixture.model };
    },
  };
}

function describeMiss(fixture: Fixture, key: string, current: string[], messages: Message[]): string {
  const sameKey = fixture.entries.some((entry) => entry.key === key);
  if (sameKey) return `录音 ${key} 已用完：这次运行调用模型的次数比录制时多`;
  let best = { prefix: -1, entry: undefined as FixtureEntry | undefined };
  for (const entry of fixture.entries) {
    let prefix = 0;
    while (prefix < current.length && entry.messages[prefix] === current[prefix]) prefix += 1;
    if (prefix > best.prefix) best = { prefix, entry };
  }
  const at = best.prefix;
  const changed = messages[at];
  const where = changed
    ? `第 ${at + 1} 条消息（${changed.role}）与最接近的录音不同，当前内容：${redactSecrets(changed.content.slice(0, 140))}`
    : '消息相同，工具定义或输出格式变了';
  return `回放未命中（请求 ${key}）：${where}。请求和录制时不一致，需要重新录制或确认这是预期的改动`;
}

export function loadFixture(path: string): Fixture {
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}
