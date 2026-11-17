import type { ChatModel, Message, ModelResponse, ToolCall, ToolSpec, Usage } from '../llm/types.ts';
import { validate, type JsonSchema } from './schema.ts';
import { REPAIR_MARKER } from './stochastic.ts';

// 第 24 章：结构化输出的校验与修复循环。
// 不管服务商有没有 strict 模式，进入业务逻辑之前都在本地按同一份 schema 再校验一次：
// 兼容服务不一定支持 strict，strict 也不覆盖所有关键字（例如 maxLength），回答还可能被截断或拒答。

export type ParseResult = { ok: true; value: unknown; lenient: boolean } | { ok: false; error: string };

/** 解析模型输出的 JSON。lenient = 允许去掉 ```json 代码块和前后多余的文字，计入指标单独统计 */
export function parseJson(text: string, lenient = false): ParseResult {
  try {
    return { ok: true, value: JSON.parse(text), lenient: false };
  } catch {
    if (lenient) {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return { ok: true, value: JSON.parse(text.slice(start, end + 1)), lenient: true };
        } catch {
          // 落到下面统一报错
        }
      }
    }
    return { ok: false, error: `$: 不是合法 JSON（${text.slice(0, 40)}${text.length > 40 ? '…' : ''}）` };
  }
}

export interface StructuredOptions {
  name: string;
  schema: JsonSchema;
  /** 校验失败后最多让模型再改几次。0 = 不修复 */
  maxRepairs?: number;
  lenient?: boolean;
  /** 交给服务商的 strict 标志；本地校验总是执行 */
  strict?: boolean;
  signal?: AbortSignal;
}

export type StructuredResult<T> =
  | { ok: true; value: T; attempts: number; lenient: boolean; usage: Usage }
  | { ok: false; errors: string[]; attempts: number; usage: Usage };

export async function completeStructured<T>(model: ChatModel, messages: Message[], options: StructuredOptions): Promise<StructuredResult<T>> {
  const { name, schema, maxRepairs = 2, lenient = false, strict = true, signal } = options;
  const history = [...messages];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let errors: string[] = [];
  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    const response = await model.complete({ messages: history, responseFormat: { name, schema, strict }, maxOutputTokens: 500, signal });
    addUsage(usage, response.usage);
    const text = response.message.content;
    if (response.finishReason === 'length') {
      errors = ['$: 输出被长度截断'];
    } else {
      const parsed = parseJson(text, lenient);
      errors = parsed.ok ? validate(schema, parsed.value) : [parsed.error];
      if (parsed.ok && errors.length === 0) return { ok: true, value: parsed.value as T, attempts: attempt, lenient: parsed.lenient, usage };
    }
    // 把具体错误发回去，比“格式不对，请重试”有效得多；只发路径和原因，不重复整个 schema
    history.push({ role: 'assistant', content: text });
    history.push({ role: 'user', content: `你的输出${REPAIR_MARKER}：\n${errors.map((e) => `- ${e}`).join('\n')}\n请只输出修正后的 JSON 对象，不要解释。` });
  }
  return { ok: false, errors, attempts: maxRepairs + 1, usage };
}

export interface RepairStats {
  total: number;
  firstPass: number;
  repaired: number;
  gaveUp: number;
  lenient: number;
  modelCalls: number;
}

export function emptyRepairStats(): RepairStats {
  return { total: 0, firstPass: 0, repaired: 0, gaveUp: 0, lenient: 0, modelCalls: 0 };
}

export function recordRepair(stats: RepairStats, result: { ok: boolean; attempts: number; lenient?: boolean }) {
  stats.total += 1;
  stats.modelCalls += result.attempts;
  if (!result.ok) stats.gaveUp += 1;
  else if (result.attempts === 1) stats.firstPass += 1;
  else stats.repaired += 1;
  if (result.ok && result.lenient) stats.lenient += 1;
}

/** 校验一次工具调用：工具存在、参数是合法 JSON、符合工具的 parameters schema */
export function checkToolCall(call: ToolCall, tools: ToolSpec[]): string[] {
  const spec = tools.find((tool) => tool.name === call.name);
  if (!spec) return [`没有名为 ${call.name} 的工具，可用：${tools.map((tool) => tool.name).join(', ')}`];
  const parsed = parseJson(call.arguments || '{}');
  if (!parsed.ok) return [parsed.error];
  return validate(spec.parameters, parsed.value);
}

export interface ToolArgValidator extends ChatModel {
  stats(): RepairStats;
}

/**
 * 包在模型外面：模型给出的工具调用不合法时，不交给 Agent 执行，而是把错误当作工具结果发回去让它重新给出。
 * 修复发生在同一个“步骤”里：不占 Agent 的步数，非法参数也不会出现在事件日志和工具里。
 * 修复的调用同样计费，所以 usage 是所有尝试的总和。修不好就原样返回，交给 Agent 现有的参数检查兜底。
 */
export function createToolArgValidator(model: ChatModel, options: { maxRepairs?: number } = {}): ToolArgValidator {
  const maxRepairs = options.maxRepairs ?? 2;
  const stats = emptyRepairStats();
  return {
    name: model.name,
    stats: () => ({ ...stats }),
    async complete(request) {
      const tools = request.tools ?? [];
      const history = [...request.messages];
      const usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let response: ModelResponse;
      let attempts = 0;
      while (true) {
        attempts += 1;
        response = await model.complete({ ...request, messages: history });
        addUsage(usage, response.usage);
        const calls = response.finishReason === 'length' ? [] : response.message.toolCalls ?? [];
        const problems = calls.map((call) => checkToolCall(call, tools));
        if (calls.length === 0 || problems.every((p) => p.length === 0)) break;
        if (attempts > maxRepairs) {
          recordRepair(stats, { ok: false, attempts });
          return { ...response, usage };
        }
        history.push(response.message);
        // 协议要求每个 tool_call 都有对应结果；同一批里合法的调用也不执行，让模型整体重新给出
        calls.forEach((call, i) => history.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(problems[i].length
            ? { ok: false, error: { code: 'INVALID_ARGUMENTS', message: problems[i].join('；') } }
            : { ok: false, error: { code: 'NOT_EXECUTED', message: '同一批调用中有参数错误，本批都未执行，请重新给出' } }),
        }));
      }
      if (response.message.toolCalls?.length) recordRepair(stats, { ok: true, attempts });
      else if (attempts > 1) recordRepair(stats, { ok: false, attempts });
      return { ...response, usage };
    },
  };
}

function addUsage(total: Usage, usage: Usage) {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  if (usage.estimated) total.estimated = true;
}
