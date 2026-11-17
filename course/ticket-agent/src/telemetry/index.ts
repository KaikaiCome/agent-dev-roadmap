import { AgentTelemetry } from './genai.ts';
import { BatchSpanProcessor } from './otlp.ts';
import { Tracer } from './trace.ts';

export { AgentTelemetry, activeTelemetry } from './genai.ts';

export interface Telemetry {
  agent: AgentTelemetry;
  processor: BatchSpanProcessor;
  /** 优雅退出时调用：把队列里剩下的 span 发出去（有超时，收集端挂了也不会卡住退出） */
  shutdown(): Promise<void>;
}

/**
 * 按 OpenTelemetry 的标准环境变量创建遥测。没有设置 OTEL_EXPORTER_OTLP_ENDPOINT（或 …_TRACES_ENDPOINT）时返回 undefined：
 * 完全不创建 span、不改出站请求，行为和前面章节一模一样。
 */
export function createTelemetry(
  model: { provider: 'mock' | 'openai'; baseURL: string },
  env: Record<string, string | undefined> = process.env,
  onError: (message: string) => void = () => {},
): Telemetry | undefined {
  if (env.OTEL_SDK_DISABLED === 'true') return undefined;
  const url = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    ?? (env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, '')}/v1/traces` : undefined);
  if (!url) return undefined;

  const sampleRatio = Number(env.OTEL_TRACES_SAMPLER_ARG ?? 1);
  if (!(sampleRatio >= 0 && sampleRatio <= 1)) throw new Error(`OTEL_TRACES_SAMPLER_ARG 必须在 0 到 1 之间，当前是 ${env.OTEL_TRACES_SAMPLER_ARG}`);
  // 语义约定规定的开关：SPAN_ONLY / SPAN_AND_EVENT 才在 span 上记录内容，其他值（包括写错的）一律不记录
  const capture = (env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT ?? '').toUpperCase();

  // 收集端挂了时每批都会失败，日志里每分钟最多提示一次，避免刷屏
  let lastError = 0;
  const processor = new BatchSpanProcessor({
    url,
    headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    resource: {
      'service.name': env.OTEL_SERVICE_NAME ?? 'ticket-agent',
      'telemetry.sdk.name': 'ticket-agent-mini-tracer',
      'telemetry.sdk.language': 'nodejs',
    },
    onError: (message) => {
      if (Date.now() - lastError < 60_000) return;
      lastError = Date.now();
      onError(message);
    },
  });
  const agent = new AgentTelemetry({
    tracer: new Tracer({ processor, sampleRatio }),
    provider: model.provider === 'mock' ? 'mock' : providerName(model.baseURL),
    serverURL: model.provider === 'mock' ? undefined : model.baseURL,
    captureContent: capture === 'SPAN_ONLY' || capture === 'SPAN_AND_EVENT',
  });
  return { agent, processor, shutdown: () => processor.shutdown() };
}

/** gen_ai.provider.name 的规定取值。兼容 OpenAI 协议但认不出来的服务按 openai 记 */
function providerName(baseURL: string): string {
  const host = new URL(baseURL).hostname;
  if (host.endsWith('deepseek.com')) return 'deepseek';
  if (host.endsWith('openai.azure.com')) return 'azure.ai.openai';
  if (host.endsWith('moonshot.cn') || host.endsWith('moonshot.ai')) return 'moonshot_ai';
  return 'openai';
}

/** OTEL_EXPORTER_OTLP_HEADERS 格式：key1=value1,key2=value2（值可以 URL 编码），常用来放收集端的鉴权 token */
function parseHeaders(value = ''): Record<string, string> {
  return Object.fromEntries(value.split(',').map((pair) => pair.split('=')).filter(([key, v]) => key?.trim() && v !== undefined)
    .map(([key, ...rest]) => [key.trim(), decodeURIComponent(rest.join('=').trim())]));
}
