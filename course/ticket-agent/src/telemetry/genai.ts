import type { User } from '../data/seed.ts';
import type { AgentEvent, RunStatus } from '../events.ts';
import { ModelError } from '../llm/openai.ts';
import type { Message, ModelRequest, ModelResponse, ToolCall } from '../llm/types.ts';
import type { Store } from '../store.ts';
import { activeOwner, parseTraceparent, SpanKind, withSpanContext, type Tracer } from './trace.ts';

// 把 Agent 的一次 run 翻译成 OpenTelemetry GenAI 语义约定的 span 树：
//
//   invoke_agent ticket-agent        一次 runAgent 调用（审批后恢复会是新的一段）
//   ├─ chat deepseek-chat            每次模型调用（CLIENT）
//   ├─ approval_wait create_ticket   员工从看到确认卡片到点按钮的时间（自定义 span）
//   ├─ execute_tool search_knowledge 每次工具调用
//   └─ execute_tool research
//      └─ invoke_agent research      子 Agent 的 run，自动挂在这次工具调用下面
//         └─ chat …
//
// 属性名来自 OTel GenAI 语义约定（写作时全部处于 Development 状态，名字可能还会变，
// 所以集中在这一个文件里）。error.type、server.address、server.port 是已稳定的通用属性。
// 以 app. 开头的是本项目自定义属性。

export interface AgentTelemetryOptions {
  tracer: Tracer;
  /** gen_ai.provider.name，例如 deepseek、openai；离线假模型用自定义值 mock */
  provider: string;
  /** 模型服务地址，用于 server.address / server.port */
  serverURL?: string;
  /**
   * 是否在 span 上记录提示词、回答、工具参数和结果。默认 false：这些内容可能包含员工个人信息和公司数据，
   * 而 trace 后端的访问控制、保留期通常比业务数据库宽松得多。对应 OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT
   */
  captureContent?: boolean;
  /** 根 run 的 gen_ai.agent.name */
  agentName?: string;
}

export interface RunInfo {
  runId: string;
  user: User;
  store: Store;
  model: string;
}

export class AgentTelemetry {
  readonly tracer: Tracer;
  readonly captureContent: boolean;
  #options: AgentTelemetryOptions;
  #server?: { address: string; port: number };

  constructor(options: AgentTelemetryOptions) {
    this.tracer = options.tracer;
    this.captureContent = options.captureContent ?? false;
    this.#options = options;
    if (options.serverURL) {
      const url = new URL(options.serverURL);
      this.#server = { address: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
    }
  }

  /** 在上游请求的 trace 里执行 fn。没有或无法解析 traceparent 时开一条新 trace */
  continueFrom<T>(traceparent: string | string[] | undefined, fn: () => T): T {
    const remote = parseTraceparent(traceparent);
    return remote ? withSpanContext(remote, this, fn) : fn();
  }

  /** 一段 run（invoke_agent span）。子 Agent 的 run 也走这里，凭当前上下文自动成为子 span */
  async run(info: RunInfo, fn: () => Promise<RunStatus>): Promise<RunStatus> {
    const before = info.store.events(info.runId);
    const started = before.find((e) => e.type === 'run_started');
    const link = started?.type === 'run_started' ? started.data : undefined;
    const agentName = link?.agent ?? this.#options.agentName ?? 'ticket-agent';
    const span = this.tracer.startSpan(`invoke_agent ${agentName}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.provider.name': this.#options.provider,
        'gen_ai.agent.name': agentName,
        'gen_ai.request.model': info.model,
        // run id 是高基数的值：放在属性里可以按它搜索，但绝不能放进 span 名
        'app.run.id': info.runId,
        'app.run.parent_id': link?.parentRunId,
        'app.tenant.id': info.user.tenantId,
        // 第二段及以后（审批后恢复、崩溃后恢复）
        'app.run.resumed': before.some((e) => e.type === 'assistant_message'),
      },
    });
    try {
      const status = await withSpanContext(span.context, this, fn);
      const after = info.store.events(info.runId);
      const usage = sumUsage(after.slice(before.length));
      span.setAttributes({ 'app.run.status': status, 'gen_ai.usage.input_tokens': usage.input, 'gen_ai.usage.output_tokens': usage.output });
      const finished = after.findLast((e) => e.type === 'run_finished');
      const reason = finished?.type === 'run_finished' ? finished.data.reason : undefined;
      // 用户取消不是系统错误；超预算、失败才计入错误
      if (status === 'failed' || status === 'budget_exceeded') span.fail(status, reason);
      return status;
    } catch (error) {
      span.fail(errorType(error));
      throw error;
    } finally {
      span.end();
    }
  }

  /** 一次模型调用（chat span）。重试发生在 fn 内部，所以一个 span 覆盖包括重试在内的整个逻辑调用 */
  async chat(model: string, request: ModelRequest, fn: (request: ModelRequest) => Promise<ModelResponse>): Promise<ModelResponse> {
    const span = this.tracer.startSpan(`chat ${model}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': this.#options.provider,
        'gen_ai.request.model': model,
        'gen_ai.request.max_tokens': request.maxOutputTokens,
        'gen_ai.request.stream': true,
        'server.address': this.#server?.address,
        'server.port': this.#server?.port,
      },
    });
    if (this.captureContent) {
      const system = request.messages.filter((m) => m.role === 'system').map((m) => ({ type: 'text', content: m.content }));
      span.setAttribute('gen_ai.system_instructions', system);
      span.setAttribute('gen_ai.input.messages', request.messages.filter((m) => m.role !== 'system').map(toSemconvMessage));
    }
    let firstChunk: number | undefined;
    const traced: ModelRequest = {
      ...request,
      onText: (delta) => {
        firstChunk ??= performance.now();
        request.onText?.(delta);
      },
    };
    const t0 = performance.now();
    try {
      // 模型适配器在这个上下文里发 HTTP 请求，traceHeaders() 拿到的就是这个 chat span
      const response = await withSpanContext(span.context, this, () => fn(traced));
      span.setAttributes({
        'gen_ai.response.model': response.model ?? model,
        'gen_ai.response.finish_reasons': [response.finishReason],
        'gen_ai.usage.input_tokens': response.usage.inputTokens,
        'gen_ai.usage.output_tokens': response.usage.outputTokens,
        'gen_ai.response.time_to_first_chunk': firstChunk === undefined ? undefined : (firstChunk - t0) / 1000,
        'app.usage.estimated': response.usage.estimated,
      });
      if (this.captureContent) span.setAttribute('gen_ai.output.messages', [{ ...toSemconvMessage(response.message), finish_reason: response.finishReason }]);
      return response;
    } catch (error) {
      span.fail(errorType(error));
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * 一次工具调用（execute_tool span）。fn 是 agent.ts 里的 executeToolCall，它的结果写在事件日志里，
   * 所以 span 的结论（成功、错误码、审批）从日志读，保证 trace 和审计日志说的是同一件事。
   */
  async tool(call: ToolCall, info: { runId: string; store: Store }, fn: () => Promise<'done' | 'paused'>): Promise<'done' | 'paused'> {
    const events = info.store.events(info.runId);
    this.#approvalWait(call, events);
    const span = this.tracer.startSpan(`execute_tool ${call.name}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': call.name,
        'gen_ai.tool.call.id': call.id,
        'gen_ai.tool.type': 'function',
      },
    });
    if (this.captureContent) span.setAttribute('gen_ai.tool.call.arguments', call.arguments);
    try {
      const outcome = await withSpanContext(span.context, this, fn);
      // 在等员工确认：工具并没有执行，不产生 execute_tool span，等待时间由恢复后的 approval_wait span 记录
      if (outcome === 'paused') {
        span.drop();
        return outcome;
      }
      const finished = info.store.events(info.runId, events.at(-1)?.seq ?? 0)
        .find((e) => e.type === 'tool_finished' && e.data.callId === call.id);
      if (finished?.type === 'tool_finished') {
        if (!finished.data.ok) span.fail(finished.data.error?.code ?? '_OTHER', finished.data.error?.message);
        else if (this.captureContent) span.setAttribute('gen_ai.tool.call.result', JSON.stringify(finished.data.result));
      }
      span.end();
      return outcome;
    } catch (error) {
      span.fail(errorType(error));
      span.end();
      throw error;
    }
  }

  /** 审批等待：从 approval_requested 到 approval_resolved。事后补记，起止时间取自事件日志 */
  #approvalWait(call: ToolCall, events: AgentEvent[]) {
    const requested = events.find((e) => e.type === 'approval_requested' && e.data.callId === call.id);
    const resolved = events.find((e) => e.type === 'approval_resolved' && e.data.callId === call.id);
    if (requested?.type !== 'approval_requested' || resolved?.type !== 'approval_resolved') return;
    if (events.some((e) => e.type === 'tool_finished' && e.data.callId === call.id)) return;
    const span = this.tracer.startSpan(`approval_wait ${call.name}`, {
      startMs: Date.parse(requested.createdAt),
      attributes: {
        'gen_ai.tool.name': call.name,
        'gen_ai.tool.call.id': call.id,
        'app.approval.approved': resolved.data.approved,
        'app.approval.reason': resolved.data.reason,
      },
    });
    span.end(Date.parse(resolved.createdAt));
  }
}

/** 当前上下文里的遥测实例。子 Agent 的 runAgent 没有显式传入遥测，靠它继承父 run 的 */
export function activeTelemetry(): AgentTelemetry | undefined {
  const owner = activeOwner();
  return owner instanceof AgentTelemetry ? owner : undefined;
}

/** 低基数的错误类别：HTTP 状态码、取消、超时，或异常类名 */
function errorType(error: unknown): string {
  if (error instanceof ModelError) return String(error.status);
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return error.name === 'TimeoutError' ? 'timeout' : 'cancelled';
  if (error instanceof Error) return error.name || '_OTHER';
  return '_OTHER';
}

function sumUsage(events: AgentEvent[]) {
  let input = 0;
  let output = 0;
  for (const event of events) {
    if (event.type !== 'usage') continue;
    input += event.data.inputTokens;
    output += event.data.outputTokens;
  }
  return { input, output };
}

/** 转成语义约定的消息结构：{ role, parts: [{ type: 'text' | 'tool_call' | 'tool_call_response', … }] } */
function toSemconvMessage(message: Message) {
  switch (message.role) {
    case 'assistant':
      return {
        role: 'assistant',
        parts: [
          ...(message.content ? [{ type: 'text', content: message.content }] : []),
          ...(message.toolCalls ?? []).map((call) => ({ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments })),
        ],
      };
    case 'tool':
      return { role: 'tool', parts: [{ type: 'tool_call_response', id: message.toolCallId, response: message.content }] };
    default:
      return { role: message.role, parts: [{ type: 'text', content: message.content }] };
  }
}
