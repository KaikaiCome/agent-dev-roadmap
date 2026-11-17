import { createMockModel } from '../llm/mock.ts';
import type { AssistantMessage, ChatModel, Message, ModelRequest, ModelResponse } from '../llm/types.ts';

// 第 24 章：会“犯错”的离线模型。在第 2 章的 mock 外面套一层固定种子的随机扰动，
// 模仿真实模型最常见的几类不稳定：跳过检索直接凭印象回答、调错工具、参数 JSON 不完整、换一种说法、
// 结构化输出带代码块 / 缺字段 / 枚举写错。种子相同，同样的调用顺序就得到同样的结果，测试和报告都能复现。
// 它模仿的是“错误的形态”，不是真实模型的错误率：真实的比例只能在真实模型上测（见 run-k.ts 和录制回放）。

export interface NoiseRates {
  /** 该检索时不检索，直接给出没有依据的回答 */
  skipTool: number;
  /** 调用了另一个工具（参数还是原来的） */
  wrongTool: number;
  /** 工具参数 JSON 被截断 */
  malformedArgs: number;
  /** 最终回答换一种说法 */
  paraphrase: number;
  /** 收到参数错误的反馈后，重新给出正确调用的概率（否则放弃并道歉） */
  recover: number;
  /** 结构化输出的格式错误：代码块、多余文字、缺字段、大小写、类型、超长、多余字段 */
  formatError: number;
  /** 结构化输出格式正确，但分类错了（schema 抓不到） */
  wrongLabel: number;
}

export const noiseProfiles: Record<string, NoiseRates> = {
  v1: { skipTool: 0.04, wrongTool: 0.05, malformedArgs: 0.05, paraphrase: 0.08, recover: 0.8, formatError: 0.3, wrongLabel: 0.05 },
  // 模拟服务商悄悄升级了模型：工具调用更稳，但更爱换说法
  v2: { skipTool: 0.02, wrongTool: 0.02, malformedArgs: 0.02, paraphrase: 0.45, recover: 0.9, formatError: 0.2, wrongLabel: 0.05 },
};

export type NoiseKind = 'skipTool' | 'wrongTool' | 'malformedArgs' | 'paraphrase' | 'recovered' | 'gaveUp' | 'formatError' | 'wrongLabel';

export interface StochasticModel extends ChatModel {
  /** 每种扰动实际注入了多少次，用来核对报告 */
  readonly injected: Record<NoiseKind, number>;
}

const RECOVERABLE = new Set(['INVALID_ARGUMENTS', 'UNKNOWN_TOOL', 'NOT_EXECUTED']);
export const REPAIR_MARKER = '没有通过校验';

export function createStochasticModel(options: { seed?: number; profile?: string; rates?: Partial<NoiseRates>; name?: string } = {}): StochasticModel {
  const profile = options.profile ?? 'v1';
  const base = noiseProfiles[profile];
  if (!base) throw new Error(`未知的噪声档位 ${profile}，可选：${Object.keys(noiseProfiles).join(', ')}`);
  const rates = { ...base, ...options.rates };
  const random = seededRandom(options.seed ?? 1);
  const inner = createMockModel();
  const injected = Object.fromEntries(['skipTool', 'wrongTool', 'malformedArgs', 'paraphrase', 'recovered', 'gaveUp', 'formatError', 'wrongLabel'].map((k) => [k, 0])) as Record<NoiseKind, number>;
  const chance = (p: number) => random() < p;
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];

  async function agentStep(request: ModelRequest): Promise<ModelResponse> {
    let messages = request.messages;
    const failedAt = failedToolTurn(messages);
    if (failedAt !== undefined) {
      if (!chance(rates.recover)) {
        injected.gaveUp += 1;
        return reply(request, { role: 'assistant', content: '抱歉，查询系统时出了点问题，请稍后再试。' });
      }
      injected.recovered += 1;
      // 去掉失败的那次调用和它的错误结果，让底层 mock 重新决策，相当于“看了报错重新来一次”
      messages = messages.slice(0, failedAt);
    }
    const { message } = await inner.complete({ ...request, messages, onText: undefined });
    const call = message.toolCalls?.[0];
    const tools = request.tools?.map((tool) => tool.name) ?? [];
    if (call) {
      if (call.name === 'search_knowledge' && chance(rates.skipTool)) {
        injected.skipTool += 1;
        return reply(request, { role: 'assistant', content: '按我的了解，这类事项一般按公司惯例办理即可，不需要额外审批。' });
      }
      if (tools.length > 1 && chance(rates.wrongTool)) {
        injected.wrongTool += 1;
        call.name = pick(tools.filter((name) => name !== call.name));
      } else if (chance(rates.malformedArgs)) {
        injected.malformedArgs += 1;
        call.arguments = call.arguments.slice(0, Math.floor(call.arguments.length / 2));
      }
    } else if (chance(rates.paraphrase)) {
      injected.paraphrase += 1;
      message.content = paraphrase(message.content, pick);
    }
    return reply(request, message);
  }

  function structuredStep(request: ModelRequest): Promise<ModelResponse> {
    const question = request.messages.find((m) => m.role === 'user')?.content ?? '';
    const last = request.messages.at(-1);
    const repairing = last?.role === 'user' && last.content.includes(REPAIR_MARKER);
    const value: Record<string, unknown> = { ...triage(question) };
    if (chance(rates.wrongLabel)) {
      injected.wrongLabel += 1;
      value.category = pick(['it', 'hr', 'finance', 'admin'].filter((c) => c !== value.category));
    }
    let content = JSON.stringify(value);
    const broken = repairing ? !chance(rates.recover) : chance(rates.formatError);
    if (broken) {
      injected.formatError += 1;
      content = breakFormat(value, question, pick);
    } else if (repairing) {
      injected.recovered += 1;
    }
    return reply(request, { role: 'assistant', content });
  }

  return {
    name: options.name ?? `mock-stochastic-${profile}`,
    injected,
    async complete(request) {
      request.signal?.throwIfAborted();
      return request.responseFormat ? structuredStep(request) : agentStep(request);
    },
  };
}

/** 固定种子的伪随机数（mulberry32），同一种子永远产生同一串数 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 最后一轮工具结果全部是“参数/工具名错误”时，返回那条 assistant 消息的下标 */
function failedToolTurn(messages: Message[]): number | undefined {
  let i = messages.length - 1;
  let sawError = false;
  while (i >= 0 && messages[i].role === 'tool') {
    const code = /"code":"(\w+)"/.exec(messages[i].content)?.[1] ?? '';
    if (messages[i].content.startsWith('{"ok":true') || !RECOVERABLE.has(code)) return undefined;
    sawError = true;
    i -= 1;
  }
  return sawError && messages[i]?.role === 'assistant' ? i : undefined;
}

function paraphrase(content: string, pick: <T>(items: T[]) => T): string {
  const variants: Array<[string, string]> = [
    ['无法给出确定答案', '给不出确定答案'],
    ['你拒绝了创建工单', '已按你的选择取消'],
    ['根据《', '参考《'],
  ].filter(([from]) => content.includes(from)) as Array<[string, string]>;
  if (variants.length === 0) return `好的，${content}`;
  const [from, to] = pick(variants);
  return content.replace(from, to);
}

function triage(question: string) {
  const category = /VPN|电脑|邮箱|密码|打印|网络|账号/.test(question) ? 'it'
    : /年假|请假|工资|社保|入职/.test(question) ? 'hr'
      : /发票|报销|采购|预算|付款/.test(question) ? 'finance' : 'admin';
  const priority = /紧急|马上|开不了|连不上|今天/.test(question) ? 'high' : /请问|怎么|几天|吗？/.test(question) ? 'low' : 'medium';
  return { category, priority, title: question.replace(/[，。？！].*$/, '').slice(0, 30), needsHuman: /帮我|报修|申请|坏|不对|没到账/.test(question) };
}

function breakFormat(value: Record<string, unknown>, question: string, pick: <T>(items: T[]) => T): string {
  const json = JSON.stringify(value);
  switch (pick(['fence', 'prose', 'missing', 'case', 'type', 'long', 'extra'])) {
    case 'fence': return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
    case 'prose': return `好的，分诊结果如下：${json}`;
    case 'missing': return JSON.stringify({ ...value, priority: undefined });
    case 'case': return JSON.stringify({ ...value, category: String(value.category).toUpperCase() });
    case 'type': return JSON.stringify({ ...value, needsHuman: value.needsHuman ? 'yes' : 'no' });
    case 'long': return JSON.stringify({ ...value, title: `员工反馈：${question}，请尽快安排相关同事跟进处理` });
    default: return JSON.stringify({ ...value, confidence: 0.9 });
  }
}

async function reply(request: ModelRequest, message: AssistantMessage): Promise<ModelResponse> {
  if (message.content) request.onText?.(message.content);
  const inputChars = request.messages.reduce((sum, m) => sum + m.content.length, 0);
  const outputChars = message.content.length + (message.toolCalls ?? []).reduce((sum, c) => sum + c.arguments.length, 0);
  return {
    message: message.toolCalls?.length ? message : { role: 'assistant', content: message.content },
    usage: { inputTokens: Math.ceil(inputChars / 2), outputTokens: Math.ceil((outputChars + 20) / 2) },
    finishReason: message.toolCalls?.length ? 'tool_calls' : 'stop',
  };
}
