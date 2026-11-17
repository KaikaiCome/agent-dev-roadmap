import {
  Agent,
  RunContext,
  Runner,
  RunState,
  tool,
  Usage,
  type AgentInputItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type protocol,
  type RunToolApprovalItem,
  type StreamEvent,
} from '@openai/agents';
import * as z from 'zod';
import type { ChatModel, Message, ToolCall } from '../src/llm/types.ts';
import { systemPrompt } from '../src/prompt.ts';
import type { Store } from '../src/store.ts';
import { approvalSummary, fieldDescription, REJECTED, referenceTools, runReferenceTool, type TicketContext } from './shared.ts';

// OpenAI Agents SDK 版本：Agent = 指令 + 工具；Runner 负责“调模型 → 执行工具 → 再调模型”的循环、
// 审批中断、追踪。我们只写工具和一个把参考项目 ChatModel 接进来的 Model 适配器。

export function createTicketAgent(store: Store) {
  const tools = referenceTools(store);
  const ref = (name: string) => tools.get(name)!;
  const field = (name: string, key: string) => fieldDescription(ref(name), key);
  const callContext = (runContext: RunContext<TicketContext> | undefined, callId = 'unknown') => {
    if (!runContext) throw new Error('缺少运行上下文');
    return { ...runContext.context, callId };
  };

  // 参数 schema 用 zod 写，SDK 转成 JSON Schema 发给模型，并在执行前校验。
  // strict 模式下所有字段都必须是 required，所以 sourceIds 不能像手写版那样可省略
  const searchKnowledge = tool({
    name: 'search_knowledge',
    description: ref('search_knowledge').spec.description,
    parameters: z.object({ query: z.string().max(200).describe(field('search_knowledge', 'query')) }),
    execute: (args, runContext?: RunContext<TicketContext>, details?) =>
      runReferenceTool(ref('search_knowledge'), args, { ...callContext(runContext, details?.toolCall?.callId), signal: details?.signal }),
  });
  const prepareTicket = tool({
    name: 'prepare_ticket',
    description: ref('prepare_ticket').spec.description,
    parameters: z.object({
      title: z.string().max(80).describe(field('prepare_ticket', 'title')),
      description: z.string().max(2000).describe(field('prepare_ticket', 'description')),
      sourceIds: z.array(z.string()).max(5).describe(field('prepare_ticket', 'sourceIds')),
    }),
    execute: (args, runContext?: RunContext<TicketContext>, details?) =>
      runReferenceTool(ref('prepare_ticket'), args, callContext(runContext, details?.toolCall?.callId)),
  });
  const createTicket = tool({
    name: 'create_ticket',
    description: ref('create_ticket').spec.description,
    parameters: z.object({ draftId: z.string().max(64).describe(field('create_ticket', 'draftId')) }),
    // 需要审批：Runner 不执行这个调用，而是把它放进 result.interruptions 并暂停整个 run
    needsApproval: true,
    execute: (args, runContext?: RunContext<TicketContext>, details?) =>
      runReferenceTool(ref('create_ticket'), args, callContext(runContext, details?.toolCall?.callId)),
  });

  const agent = new Agent<TicketContext>({
    name: 'ticket-agent',
    // 指令可以是函数：系统提示词按当前员工生成，和手写版用同一个 systemPrompt
    instructions: (runContext) => systemPrompt(runContext.context.user),
    tools: [searchKnowledge, prepareTicket, createTicket],
  });

  /** 审批界面要展示的内容。用参考项目的 describe，它会校验草稿是否属于当前员工 */
  const describe = (item: RunToolApprovalItem, context: TicketContext) => {
    const raw = item.rawItem as { callId?: string; arguments?: string };
    let args: unknown;
    try {
      args = JSON.parse(raw.arguments ?? '{}');
    } catch {
      args = raw.arguments;
    }
    return approvalSummary(ref('create_ticket'), args, { ...context, callId: raw.callId ?? '' });
  };

  return { agent, describe };
}

export type TicketAgent = ReturnType<typeof createTicketAgent>['agent'];

/** 拒绝时传给模型的工具结果。不传 message 时 SDK 用默认英文文案，模型看到的内容就和手写版不同了 */
export const rejectOptions = { message: REJECTED };

/**
 * 从序列化的 RunState 恢复（例如进程重启、审批隔天才完成）。
 * 身份用当前登录会话重新注入（contextStrategy: 'replace'），不信任状态串里存的 user。
 */
export function restoreState(agent: TicketAgent, serialized: string, context: TicketContext) {
  return RunState.fromStringWithContext<TicketContext, TicketAgent>(agent, serialized, new RunContext(context), { contextStrategy: 'replace' });
}

/** 把参考项目的 ChatModel（离线 mock 或 OpenAI 兼容适配器）接进 Agents SDK */
export class ReferenceModelProvider implements ModelProvider {
  readonly model: ChatModel;
  constructor(model: ChatModel) {
    this.model = model;
  }
  getModel(): Model {
    return new ReferenceModel(this.model);
  }
}

export function createRunner(model: ChatModel, options: { tracingDisabled?: boolean } = {}) {
  return new Runner({
    modelProvider: new ReferenceModelProvider(model),
    workflowName: 'ticket-agent',
    // 追踪数据里默认包含工具参数和模型输入输出，员工问题、工单内容都会进入追踪后端
    traceIncludeSensitiveData: false,
    tracingDisabled: options.tracingDisabled ?? false,
  });
}

let responseCounter = 0;

class ReferenceModel implements Model {
  readonly inner: ChatModel;
  constructor(inner: ChatModel) {
    this.inner = inner;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.inner.complete({
      messages: toReferenceMessages(request),
      tools: request.tools.flatMap((t) => (t.type === 'function' ? [{ name: t.name, description: t.description, parameters: t.parameters }] : [])),
      signal: request.signal,
    });
    const { inputTokens, outputTokens } = response.usage;
    return {
      responseId: `ref_${++responseCounter}`,
      usage: new Usage({ requests: 1, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }),
      output: toOutputItems(response.message.content, response.message.toolCalls ?? []),
    };
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    yield { type: 'response_started' };
    // 参考项目的 ChatModel 用回调推送增量；这里先收集再逐段转成 SDK 的流事件
    const deltas: string[] = [];
    const response = await this.inner.complete({
      messages: toReferenceMessages(request),
      tools: request.tools.flatMap((t) => (t.type === 'function' ? [{ name: t.name, description: t.description, parameters: t.parameters }] : [])),
      signal: request.signal,
      onText: (delta) => deltas.push(delta),
    });
    for (const delta of deltas) yield { type: 'output_text_delta', delta };
    const { inputTokens, outputTokens } = response.usage;
    yield {
      type: 'response_done',
      response: {
        id: `ref_${++responseCounter}`,
        usage: { requests: 1, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        output: toOutputItems(response.message.content, response.message.toolCalls ?? []),
      },
    };
  }
}

function toOutputItems(content: string, toolCalls: ToolCall[]): protocol.OutputModelItem[] {
  const items: protocol.OutputModelItem[] = [];
  if (content) items.push({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content }] });
  for (const call of toolCalls) {
    items.push({ type: 'function_call', callId: call.id, name: call.name, arguments: call.arguments, status: 'completed' });
  }
  return items;
}

/** SDK 的输入是 Responses 风格的条目列表；转回参考项目的消息格式，连续的 function_call 合并到同一条 assistant 消息 */
function toReferenceMessages(request: ModelRequest): Message[] {
  const messages: Message[] = request.systemInstructions ? [{ role: 'system', content: request.systemInstructions }] : [];
  const items: AgentInputItem[] = typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : request.input;
  for (const item of items) {
    if (item.type === 'function_call') {
      const last = messages.at(-1);
      const call = { id: item.callId, name: item.name, arguments: item.arguments };
      if (last?.role === 'assistant') last.toolCalls = [...(last.toolCalls ?? []), call];
      else messages.push({ role: 'assistant', content: '', toolCalls: [call] });
    } else if (item.type === 'function_call_result') {
      messages.push({ role: 'tool', toolCallId: item.callId, content: textOf(item.output) });
    } else if ('role' in item && (item.role === 'user' || item.role === 'assistant' || item.role === 'system')) {
      messages.push({ role: item.role, content: textOf(item.content) });
    }
  }
  return messages;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content) ? content : [content];
  return parts.map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('');
}
