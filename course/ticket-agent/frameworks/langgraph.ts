import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { Annotation, END, interrupt, MessagesAnnotation, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';
import * as z from 'zod';
import type { User } from '../src/data/seed.ts';
import type { ChatModel, Message, ModelResponse, ToolSpec } from '../src/llm/types.ts';
import { systemPrompt } from '../src/prompt.ts';
import type { Store } from '../src/store.ts';
import { approvalSummary, fieldDescription, REJECTED, referenceTools, runReferenceTool, type TicketContext } from './shared.ts';

// LangGraph 版本：显式的状态机。agent 节点调模型，approve 节点在需要时 interrupt() 暂停，
// tools 节点执行工具；每一步结束后由 checkpointer 保存状态，用 thread_id 恢复。
//
//   START → agent ─(有工具调用)→ approve → tools → agent …
//                └(没有)→ END

export interface ApprovalRequest {
  callId: string;
  summary: string;
}
/** 恢复时传入的审批结果：callId → 是否同意 */
export type ApprovalDecisions = Record<string, boolean>;

const State = Annotation.Root({
  ...MessagesAnnotation.spec,
  decisions: Annotation<ApprovalDecisions>({ reducer: (current, update) => ({ ...current, ...update }), default: () => ({}) }),
});

/**
 * 每次 invoke / stream 都要带上的配置。thread_id 用 Store 里的 runId（草稿和工单都挂在它下面）；
 * 身份放在 configurable 里由服务端每次注入，不进入图状态，也就不会从检查点里被“恢复”出来。
 */
export function threadConfig(context: TicketContext): RunnableConfig {
  return { configurable: { thread_id: context.runId, user: context.user } };
}

function contextOf(config: RunnableConfig | undefined): TicketContext {
  const configurable = config?.configurable ?? {};
  if (typeof configurable.thread_id !== 'string' || !configurable.user) throw new Error('缺少 thread_id 或 user');
  return { runId: configurable.thread_id, user: configurable.user as User };
}

export function createTicketGraph(store: Store, model: ChatModel, checkpointer: BaseCheckpointSaver) {
  const refs = referenceTools(store);
  const ref = (name: string) => refs.get(name)!;
  const field = (name: string, key: string) => fieldDescription(ref(name), key);

  // LangChain 工具 = 函数 + zod schema。第二个参数是 RunnableConfig：身份从 configurable 取，调用 id 从 toolCall 取
  const asTool = <T extends z.ZodObject>(name: string, schema: T) => tool(
    (args: z.infer<T>, config: RunnableConfig & { toolCall?: { id?: string } }) =>
      runReferenceTool(ref(name), args, { ...contextOf(config), callId: config.toolCall?.id ?? 'unknown', signal: config.signal }),
    { name, description: ref(name).spec.description, schema },
  );
  const tools: StructuredToolInterface[] = [
    asTool('search_knowledge', z.object({ query: z.string().max(200).describe(field('search_knowledge', 'query')) })),
    asTool('prepare_ticket', z.object({
      title: z.string().max(80).describe(field('prepare_ticket', 'title')),
      description: z.string().max(2000).describe(field('prepare_ticket', 'description')),
      sourceIds: z.array(z.string()).max(5).optional().describe(field('prepare_ticket', 'sourceIds')),
    })),
    asTool('create_ticket', z.object({ draftId: z.string().max(64).describe(field('create_ticket', 'draftId')) })),
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const needsApproval = new Set(['create_ticket']);
  const llm = new ReferenceChatModel({ model }).bindTools(tools);

  const lastAI = (messages: BaseMessage[]) => {
    const last = messages.at(-1);
    return last && AIMessage.isInstance(last) ? last : undefined;
  };

  const graph = new StateGraph(State)
    .addNode('agent', async (state, config) => {
      const { user } = contextOf(config);
      // 系统提示词每次现拼、不存进状态：检查点里只有对话本身
      const response = await llm.invoke([{ role: 'system', content: systemPrompt(user) }, ...state.messages], config);
      return { messages: [response] };
    })
    .addNode('approve', (state, config) => {
      const calls = (lastAI(state.messages)?.tool_calls ?? []).filter((call) => needsApproval.has(call.name) && !(call.id! in state.decisions));
      if (calls.length === 0) return {};
      const context = contextOf(config);
      // interrupt 之前的代码在恢复时会整段重跑，所以这个节点里只做无副作用的事
      const decisions = interrupt<ApprovalRequest[], ApprovalDecisions>(
        calls.map((call) => ({ callId: call.id!, summary: approvalSummary(ref(call.name), call.args, { ...context, callId: call.id! }) })),
      );
      return { decisions: Object.fromEntries(calls.map((call) => [call.id!, decisions?.[call.id!] === true])) };
    })
    .addNode('tools', async (state, config) => {
      const results: ToolMessage[] = [];
      for (const call of lastAI(state.messages)?.tool_calls ?? []) {
        const target = byName.get(call.name);
        if (!target) {
          results.push(new ToolMessage({ tool_call_id: call.id!, content: JSON.stringify({ ok: false, error: { code: 'UNKNOWN_TOOL', message: `没有名为 ${call.name} 的工具` } }) }));
        } else if (needsApproval.has(call.name) && state.decisions[call.id!] !== true) {
          results.push(new ToolMessage({ tool_call_id: call.id!, content: REJECTED }));
        } else {
          // 用 ToolCall 调用工具会直接得到 ToolMessage，并触发 handleToolStart/End 回调（追踪）
          results.push(await target.invoke({ ...call, type: 'tool_call' }, config));
        }
      }
      return { messages: results };
    })
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', (state) => (lastAI(state.messages)?.tool_calls?.length ? 'approve' : END), ['approve', END])
    .addEdge('approve', 'tools')
    .addEdge('tools', 'agent');

  return graph.compile({ checkpointer });
}

export type TicketGraph = ReturnType<typeof createTicketGraph>;

/** 当前线程是否停在审批上，以及要给员工看什么。流式运行结束后也用它判断 */
export async function pendingApprovals(graph: TicketGraph, config: RunnableConfig): Promise<ApprovalRequest[]> {
  const snapshot = await graph.getState(config);
  return snapshot.tasks.flatMap((task) => task.interrupts.flatMap((item) => item.value as ApprovalRequest[]));
}

/** 把参考项目的 ChatModel 包成 LangChain 聊天模型。真实项目里这里换成 ChatOpenAI 等现成实现 */
export class ReferenceChatModel extends BaseChatModel {
  readonly model: ChatModel;
  readonly tools: ToolSpec[];

  constructor(fields: { model: ChatModel; tools?: ToolSpec[] } & BaseChatModelParams) {
    super(fields);
    this.model = fields.model;
    this.tools = fields.tools ?? [];
  }

  _llmType() {
    return 'ticket-agent-reference';
  }

  override bindTools(tools: StructuredToolInterface[]) {
    const specs = tools.map((t) => {
      const { function: fn } = convertToOpenAITool(t);
      return { name: fn.name, description: fn.description ?? '', parameters: fn.parameters as Record<string, unknown> };
    });
    return new ReferenceChatModel({ model: this.model, tools: specs });
  }

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    const response = await this.#complete(messages, options.signal);
    return { generations: [{ text: response.message.content, message: toAIMessage(response) }] };
  }

  async *_streamResponseChunks(messages: BaseMessage[], options: this['ParsedCallOptions'], runManager?: CallbackManagerForLLMRun) {
    const deltas: string[] = [];
    const response = await this.#complete(messages, options.signal, (delta) => deltas.push(delta));
    for (const delta of deltas) {
      const chunk = new ChatGenerationChunk({ text: delta, message: new AIMessageChunk({ content: delta }) });
      yield chunk;
      await runManager?.handleLLMNewToken(delta, undefined, undefined, undefined, undefined, { chunk });
    }
    const final = toAIMessage(response);
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({
        content: '',
        tool_call_chunks: (final.tool_calls ?? []).map((call, index) => ({ type: 'tool_call_chunk', id: call.id, name: call.name, args: JSON.stringify(call.args), index })),
        usage_metadata: final.usage_metadata,
      }),
    });
  }

  #complete(messages: BaseMessage[], signal?: AbortSignal, onText?: (delta: string) => void) {
    return this.model.complete({ messages: messages.map(toReferenceMessage), tools: this.tools, signal, onText });
  }
}

function toAIMessage(response: ModelResponse): AIMessage {
  const { inputTokens, outputTokens } = response.usage;
  return new AIMessage({
    content: response.message.content,
    tool_calls: (response.message.toolCalls ?? []).map((call) => ({ type: 'tool_call', id: call.id, name: call.name, args: JSON.parse(call.arguments || '{}') })),
    usage_metadata: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  });
}

function toReferenceMessage(message: BaseMessage): Message {
  const content = message.text;
  switch (message.type) {
    case 'system': return { role: 'system', content };
    case 'human': return { role: 'user', content };
    case 'tool': return { role: 'tool', toolCallId: (message as ToolMessage).tool_call_id, content };
    case 'ai': {
      const calls = (message as AIMessage).tool_calls ?? [];
      return { role: 'assistant', content, ...(calls.length ? { toolCalls: calls.map((c) => ({ id: c.id!, name: c.name, arguments: JSON.stringify(c.args) })) } : {}) };
    }
    default: throw new Error(`不支持的消息类型 ${message.type}`);
  }
}
