import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

// 第 22 章：一个够用的最小 tracer，零依赖。概念和 OpenTelemetry SDK 一一对应：
// Span（一段有起止时间的操作）、SpanContext（traceId + spanId + 采样标志，跨进程传播的就是它）、
// 当前上下文（用 AsyncLocalStorage 保存，await 之后仍然能找到父 span）、SpanProcessor（span 结束后交给谁）。
// 生产环境请直接用 @opentelemetry/sdk-node；这里手写是为了看清每一步在做什么。

export interface SpanContext {
  /** 32 位十六进制，整条调用链共享 */
  traceId: string;
  /** 16 位十六进制，每个 span 一个 */
  spanId: string;
  /** 头部采样的结果，随 traceparent 传给下游：上游决定不采，下游也不采 */
  sampled: boolean;
}

export const SpanKind = { INTERNAL: 1, SERVER: 2, CLIENT: 3 } as const;
export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];

/** 属性值：字符串、数字、布尔、数组；GenAI 的消息内容是结构化对象（OTel 的 AnyValue） */
export type Attributes = Record<string, unknown>;

export interface SpanEvent {
  name: string;
  timeMs: number;
  attributes: Attributes;
}

export interface FinishedSpan {
  name: string;
  kind: SpanKind;
  context: SpanContext;
  parentSpanId?: string;
  startMs: number;
  endMs: number;
  attributes: Attributes;
  events: SpanEvent[];
  status: { code: 'unset' | 'ok' | 'error'; message?: string };
}

export interface SpanProcessor {
  onEnd(span: FinishedSpan): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  /** 缺省取当前上下文里的 span；传 null 表示开一条新 trace */
  parent?: SpanContext | null;
  /** 毫秒时间戳。事后补记的 span（例如审批等待）用事件日志里的时间 */
  startMs?: number;
}

/** 当前上下文：活动的 span，以及创建它的对象（子 Agent 的 run 靠它找到遥测实例，见 genai.ts） */
interface Context {
  span: SpanContext;
  owner?: unknown;
}

const storage = new AsyncLocalStorage<Context>();

export function activeSpanContext(): SpanContext | undefined {
  return storage.getStore()?.span;
}

export function activeOwner(): unknown {
  return storage.getStore()?.owner;
}

export function withSpanContext<T>(span: SpanContext, owner: unknown, fn: () => T): T {
  return storage.run({ span, owner }, fn);
}

const now = () => performance.timeOrigin + performance.now();

export class Span {
  readonly name: string;
  readonly kind: SpanKind;
  readonly context: SpanContext;
  readonly parentSpanId?: string;
  readonly startMs: number;
  readonly attributes: Attributes = {};
  readonly events: SpanEvent[] = [];
  status: FinishedSpan['status'] = { code: 'unset' };
  #ended = false;
  #onEnd: (span: FinishedSpan) => void;

  constructor(name: string, context: SpanContext, options: SpanOptions & { parentSpanId?: string }, onEnd: (span: FinishedSpan) => void) {
    this.name = name;
    this.kind = options.kind ?? SpanKind.INTERNAL;
    this.context = context;
    this.parentSpanId = options.parentSpanId;
    this.startMs = options.startMs ?? now();
    this.#onEnd = onEnd;
    this.setAttributes(options.attributes ?? {});
  }

  setAttribute(key: string, value: unknown): this {
    if (!this.#ended && value !== undefined && value !== null) this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Attributes): this {
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value);
    return this;
  }

  addEvent(name: string, attributes: Attributes = {}, timeMs = now()): this {
    if (!this.#ended) this.events.push({ name, timeMs, attributes });
    return this;
  }

  /** 按 OTel 的“记录错误”约定：error.type 放低基数的错误类别，status 标为 error */
  fail(errorType: string, message?: string): this {
    this.setAttribute('error.type', errorType);
    this.status = { code: 'error', ...(message ? { message } : {}) };
    return this;
  }

  end(endMs = now()): void {
    if (this.#ended) return;
    this.#ended = true;
    // 没被采样的 span 照样参与上下文传播（下游据此也不采样），只是不导出
    if (this.context.sampled) {
      this.#onEnd({
        name: this.name, kind: this.kind, context: this.context, parentSpanId: this.parentSpanId,
        startMs: this.startMs, endMs: Math.max(endMs, this.startMs), attributes: this.attributes, events: this.events, status: this.status,
      });
    }
  }

  /** 丢弃：结束但不导出。用于事后发现“这一步其实没发生”（例如工具调用在等审批，并没有执行） */
  drop(): void {
    this.#ended = true;
  }
}

export interface TracerOptions {
  processor: SpanProcessor;
  /** 头部采样比例，0~1。只对新开的 trace 生效；有父 span 时跟随父 span 的决定（parent-based） */
  sampleRatio?: number;
}

export class Tracer {
  readonly processor: SpanProcessor;
  readonly sampleRatio: number;

  constructor(options: TracerOptions) {
    this.processor = options.processor;
    this.sampleRatio = options.sampleRatio ?? 1;
  }

  startSpan(name: string, options: SpanOptions = {}): Span {
    const parent = options.parent === undefined ? activeSpanContext() : options.parent ?? undefined;
    const traceId = parent?.traceId ?? randomHex(16);
    const sampled = parent ? parent.sampled : sampleByTraceId(traceId, this.sampleRatio);
    return new Span(name, { traceId, spanId: randomHex(8), sampled }, { ...options, parentSpanId: parent?.spanId }, (span) => {
      // 导出出错绝不能影响业务：processor 自己吞掉错误，这里再兜一层
      try {
        this.processor.onEnd(span);
      } catch { /* 丢弃这条 span */ }
    });
  }
}

/** 用 traceId 的后 8 位决定是否采样：同一条 trace 在任何服务上算出来的结果都一样 */
function sampleByTraceId(traceId: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  return parseInt(traceId.slice(-8), 16) / 0x1_0000_0000 < ratio;
}

function randomHex(bytes: number): string {
  let id = '';
  // 全 0 的 id 在 W3C Trace Context 里是非法值
  while (!id || /^0+$/.test(id)) id = randomBytes(bytes).toString('hex');
  return id;
}

// ---- W3C Trace Context：traceparent = 版本-traceId-父 spanId-标志 ----

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/** 解析失败一律返回 undefined（当作没有上游），而不是报错：调用方传来的头不可信，不能因此拒绝请求 */
export function parseTraceparent(header: string | string[] | undefined): SpanContext | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value ? TRACEPARENT.exec(value.trim()) : null;
  if (!match) return undefined;
  const [, version, traceId, spanId, flags, rest] = match;
  if (version === 'ff' || (version === '00' && rest)) return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(context: SpanContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

/** 出站 HTTP 请求要带的头。没有活动 span（遥测关闭）时返回空对象，请求和以前完全一样 */
export function traceHeaders(): Record<string, string> {
  const context = activeSpanContext();
  return context ? { traceparent: formatTraceparent(context) } : {};
}
