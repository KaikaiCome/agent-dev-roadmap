import { traceHeaders } from '../telemetry/trace.ts';
import { readSSE } from './sse.ts';
import type { ChatModel, Message, ModelRequest, ModelResponse, ToolCall, Usage } from './types.ts';

export interface OpenAICompatibleOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** 测试时注入假的 fetch，不访问网络 */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class ModelError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** 适配 DeepSeek、通义千问、OpenAI 等兼容 Chat Completions 协议的服务 */
export function createOpenAICompatibleModel(options: OpenAICompatibleOptions): ChatModel {
  return { name: options.model, complete: (request) => complete(options, request) };
}

async function complete(options: OpenAICompatibleOptions, request: ModelRequest): Promise<ModelResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? abortableSleep;
  const maxRetries = options.maxRetries ?? 2;
  const body = JSON.stringify({
    model: options.model,
    messages: request.messages.map(toWireMessage),
    tools: request.tools?.length
      ? request.tools.map((tool) => ({ type: 'function', function: tool }))
      : undefined,
    max_tokens: request.maxOutputTokens,
    response_format: request.responseFormat
      ? { type: 'json_schema', json_schema: { name: request.responseFormat.name, schema: request.responseFormat.schema, strict: request.responseFormat.strict ?? true } }
      : undefined,
    stream: true,
    stream_options: { include_usage: true },
  });

  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(`${options.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}`, ...traceHeaders() },
        body,
        signal,
      });
    } catch (error) {
      // 用户主动取消不重试；连接失败、超时这类网络错误可以重试
      if (request.signal?.aborted || attempt >= maxRetries) throw error;
      await sleep(backoffMs(attempt), request.signal);
      continue;
    }

    if (response.ok && response.body) {
      let emitted = false;
      try {
        return await readStream(response.body, body.length, (delta) => {
          emitted = true;
          request.onText?.(delta);
        });
      } catch (error) {
        // 还没向用户输出文字时，读流失败可以安全重试；已经输出了就不能重试，否则内容会重复
        if (emitted || request.signal?.aborted || attempt >= maxRetries) throw error;
        await sleep(backoffMs(attempt), request.signal);
        continue;
      }
    }

    const text = await response.text().catch(() => '');
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxRetries) {
      await sleep(backoffMs(attempt, response.headers.get('retry-after')), request.signal);
      continue;
    }
    throw new ModelError(`模型服务返回 ${response.status}: ${text.slice(0, 300)}`, response.status, retryable);
  }
}

async function readStream(body: ReadableStream<Uint8Array>, inputChars: number, onText: (delta: string) => void): Promise<ModelResponse> {
  let content = '';
  let finishReason = 'unknown';
  let usage: Usage | undefined;
  let done = false;
  const calls: ToolCall[] = [];

  for await (const data of readSSE(body)) {
    if (data === '[DONE]') {
      done = true;
      break;
    }
    const chunk = JSON.parse(data);
    if (chunk.usage) {
      usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (delta.content) {
      content += delta.content;
      onText(delta.content);
    }
    // 工具调用的参数也是分块到达的，按 index 拼起来，全部收完才能解析
    for (const part of delta.tool_calls ?? []) {
      const call = (calls[part.index] ??= { id: '', name: '', arguments: '' });
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name ||= part.function.name;
      if (part.function?.arguments) call.arguments += part.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  // 连接中途断开时，收到的工具参数可能只有一半。没有结束标记的响应一律视为失败
  if (!done && finishReason === 'unknown') throw new ModelError('模型响应流意外中断', 502, true);

  const toolCalls = calls.filter(Boolean);
  const outputChars = content.length + toolCalls.reduce((sum, call) => sum + call.arguments.length, 0);
  return {
    message: { role: 'assistant', content, ...(toolCalls.length ? { toolCalls } : {}) },
    // 服务商没给用量时宁多勿少地估算，保证 token 预算仍然有效
    usage: usage ?? { inputTokens: inputChars, outputTokens: outputChars * 2, estimated: true },
    finishReason,
  };
}

function toWireMessage(message: Message): Record<string, unknown> {
  switch (message.role) {
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls?.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    default:
      return { role: message.role, content: message.content };
  }
}

/** Retry-After 可能是秒数，也可能是 HTTP 日期；最长等 30 秒 */
function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  }
  return 500 * 2 ** attempt + Math.floor(Math.random() * 200);
}

/** 等待期间用户取消或服务停机，立即结束等待 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal!.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
