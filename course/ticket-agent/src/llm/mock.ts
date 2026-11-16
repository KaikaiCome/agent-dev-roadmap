import type { AssistantMessage, ChatModel, Message, ModelRequest, ModelResponse, ToolCall } from './types.ts';

// 离线假模型：不联网、不需要 API key、每次结果相同。
// 它用简单的关键词规则模仿“先检索 → 再拟工单 → 再创建”的决策，
// 目的是让你在没有真实模型时也能跑通和测试整条链路。它不理解语言，不能用来评估效果。
export function createMockModel(options: { delayMs?: number } = {}): ChatModel {
  return {
    name: 'mock',
    async complete(request) {
      const message = decide(request.messages, request.tools?.map((tool) => tool.name) ?? []);
      await streamText(message.content, request, options.delayMs ?? 0);
      return respond(request.messages, message);
    },
  };
}

type Reply = { content?: string; toolCalls?: { name: string; args: unknown }[] };

/** 测试专用：按顺序返回预先写好的回复。回复用完还被调用会直接报错，暴露多余的模型调用。 */
export function createScriptedModel(replies: Array<Reply | ((messages: Message[]) => Reply)>): ChatModel {
  let index = 0;
  return {
    name: 'scripted',
    async complete(request) {
      request.signal?.throwIfAborted();
      const next = replies[index++];
      if (!next) throw new Error(`脚本模型的回复已用完（第 ${index} 次调用）`);
      const reply = typeof next === 'function' ? next(request.messages) : next;
      const message: AssistantMessage = {
        role: 'assistant',
        content: reply.content ?? '',
        ...(reply.toolCalls?.length
          ? { toolCalls: reply.toolCalls.map((call, i) => ({ id: `call_${index}_${i}`, name: call.name, arguments: JSON.stringify(call.args) })) }
          : {}),
      };
      await streamText(message.content, request, 0);
      return respond(request.messages, message);
    },
  };
}

function decide(messages: Message[], tools: string[]): AssistantMessage {
  const lastUser = messages.findLastIndex((message) => message.role === 'user');
  const question = lastUser >= 0 ? messages[lastUser].content : '';
  if (tools.length === 0) {
    return text(`（离线模拟模型）收到你的问题：“${question}”。设置 MODEL_PROVIDER=openai 后将由真实模型回答。`);
  }

  const results = toolResults(messages.slice(lastUser + 1));
  const search = results.get('search_knowledge');
  const draft = results.get('prepare_ticket');
  const created = results.get('create_ticket');
  const wantsTicket = /工单|报修|提交|申请/.test(question);

  if (!search && tools.includes('search_knowledge')) {
    return call('search_knowledge', { query: question });
  }
  const hits: Array<{ sourceId: string; title: string; snippet: string }> = search?.ok ? search.data.results : [];
  if (wantsTicket && !draft && tools.includes('prepare_ticket')) {
    return call('prepare_ticket', {
      title: question.slice(0, 40),
      description: `员工请求：${question}`,
      sourceIds: hits.map((hit) => hit.sourceId),
    });
  }
  if (wantsTicket && draft?.ok && !created && tools.includes('create_ticket')) {
    return call('create_ticket', { draftId: draft.data.draftId });
  }

  const parts = hits.length
    ? [`根据《${hits[0].title}》[${hits[0].sourceId}]：${hits[0].snippet}`]
    : ['没有找到你有权限查看的相关制度，无法给出确定答案。建议咨询人事或提交工单。'];
  if (created?.ok) parts.push(`工单已创建，编号 ${created.data.ticketId}。`);
  else if (created?.error?.code === 'APPROVAL_REJECTED') parts.push('你拒绝了创建工单，没有提交任何工单。');
  else if (created) parts.push(`工单创建失败：${created.error?.message ?? '未知错误'}`);
  return text(parts.join('\n'));
}

type ToolResult = { ok: boolean; data?: any; error?: { code: string; message: string } };

function toolResults(turn: Message[]): Map<string, ToolResult> {
  const names = new Map<string, string>();
  const results = new Map<string, ToolResult>();
  for (const message of turn) {
    if (message.role === 'assistant') message.toolCalls?.forEach((c) => names.set(c.id, c.name));
    if (message.role === 'tool') {
      const name = names.get(message.toolCallId);
      if (name) results.set(name, JSON.parse(message.content));
    }
  }
  return results;
}

let callCounter = 0;
function call(name: string, args: unknown): AssistantMessage {
  const toolCall: ToolCall = { id: `mock_${++callCounter}`, name, arguments: JSON.stringify(args) };
  return { role: 'assistant', content: '', toolCalls: [toolCall] };
}

function text(content: string): AssistantMessage {
  return { role: 'assistant', content };
}

async function streamText(content: string, request: ModelRequest, delayMs: number) {
  for (let i = 0; i < content.length; i += 4) {
    request.signal?.throwIfAborted();
    request.onText?.(content.slice(i, i + 4));
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

// 假模型没有真实 token 数，用字符数粗略估算，只为让用量统计链路可测
function respond(messages: Message[], message: AssistantMessage): ModelResponse {
  const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return {
    message,
    usage: { inputTokens: Math.ceil(inputChars / 2), outputTokens: Math.ceil((message.content.length + 20) / 2) },
    finishReason: message.toolCalls ? 'tool_calls' : 'stop',
  };
}
