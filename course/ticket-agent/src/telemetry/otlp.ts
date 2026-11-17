import type { Attributes, FinishedSpan, SpanProcessor } from './trace.ts';

// OTLP/HTTP + JSON 导出器和批处理器。设计目标只有一条：遥测出任何问题，都不能拖慢或弄坏 Agent。
// - span 结束时只是放进内存队列（同步、O(1)），业务代码从不等待网络；
// - 队列有上限，满了直接丢弃并计数（宁可丢遥测，不能让内存无限增长）；
// - 后台按批发送，每次请求有超时；失败的批次直接丢弃，不重试、不阻塞后面的批次；
// - 定时器 unref()，不会因为还有遥测没发完而让进程退不出去。

export interface OtlpExporterOptions {
  /** 完整地址，例如 http://localhost:4318/v1/traces */
  url: string;
  headers?: Record<string, string>;
  /** resource 属性，至少有 service.name */
  resource: Attributes;
  timeoutMs?: number;
  maxQueueSize?: number;
  maxBatchSize?: number;
  scheduledDelayMs?: number;
  fetchImpl?: typeof fetch;
  /** 导出失败时回调（带节流由调用方决定），默认什么也不做 */
  onError?: (message: string) => void;
}

export interface ExportStats {
  exported: number;
  /** 队列满被丢弃的，加上发送失败被丢弃的 */
  dropped: number;
  failedRequests: number;
}

export class BatchSpanProcessor implements SpanProcessor {
  readonly stats: ExportStats = { exported: 0, dropped: 0, failedRequests: 0 };
  #options: Required<Omit<OtlpExporterOptions, 'headers' | 'onError'>> & Pick<OtlpExporterOptions, 'headers' | 'onError'>;
  #queue: FinishedSpan[] = [];
  #timer: NodeJS.Timeout | undefined;
  #draining: Promise<void> | undefined;
  #closed = false;

  constructor(options: OtlpExporterOptions) {
    this.#options = {
      timeoutMs: 5_000, maxQueueSize: 2_048, maxBatchSize: 256, scheduledDelayMs: 1_000, fetchImpl: fetch,
      ...options,
    };
  }

  onEnd(span: FinishedSpan): void {
    if (this.#closed || this.#queue.length >= this.#options.maxQueueSize) {
      this.stats.dropped += 1;
      return;
    }
    this.#queue.push(span);
    if (this.#queue.length >= this.#options.maxBatchSize) this.#drain();
    else if (!this.#timer) {
      this.#timer = setTimeout(() => this.#drain(), this.#options.scheduledDelayMs);
      this.#timer.unref();
    }
  }

  /** 把队列里的 span 全部发出去（发送失败的也算处理完）。优雅退出和测试时调用 */
  async forceFlush(): Promise<void> {
    while (this.#queue.length > 0 || this.#draining) await this.#drain();
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    this.#closed = true;
  }

  /** 同一时间只有一个请求在发：收集端变慢时，积压留在有上限的队列里，而不是变成无数个并发请求 */
  #drain(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#draining ??= (async () => {
      while (this.#queue.length > 0) await this.#send(this.#queue.splice(0, this.#options.maxBatchSize));
    })().finally(() => {
      this.#draining = undefined;
    });
    return this.#draining;
  }

  async #send(batch: FinishedSpan[]): Promise<void> {
    const { url, headers, resource, timeoutMs, fetchImpl, onError } = this.#options;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(toOtlpJson(batch, resource)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.stats.exported += batch.length;
    } catch (error) {
      this.stats.dropped += batch.length;
      this.stats.failedRequests += 1;
      onError?.(`OTLP 导出失败，丢弃 ${batch.length} 个 span：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** OTLP/JSON 编码：traceId/spanId 用十六进制字符串，时间用纳秒字符串，int64 用字符串 */
export function toOtlpJson(spans: FinishedSpan[], resource: Attributes) {
  return {
    resourceSpans: [{
      resource: { attributes: toKeyValues(resource) },
      scopeSpans: [{
        scope: { name: 'ticket-agent', version: '0.1.0' },
        spans: spans.map((span) => ({
          traceId: span.context.traceId,
          spanId: span.context.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: span.kind,
          startTimeUnixNano: nanos(span.startMs),
          endTimeUnixNano: nanos(span.endMs),
          attributes: toKeyValues(span.attributes),
          events: span.events.map((event) => ({ timeUnixNano: nanos(event.timeMs), name: event.name, attributes: toKeyValues(event.attributes) })),
          status: { code: { unset: 0, ok: 1, error: 2 }[span.status.code], ...(span.status.message ? { message: span.status.message } : {}) },
        })),
      }],
    }],
  };
}

function nanos(ms: number): string {
  return (BigInt(Math.round(ms * 1_000)) * 1_000n).toString();
}

function toKeyValues(attributes: Attributes) {
  return Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

export function toAnyValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toAnyValue) } };
  if (value && typeof value === 'object') return { kvlistValue: { values: toKeyValues(value as Attributes) } };
  return { stringValue: String(value) };
}
