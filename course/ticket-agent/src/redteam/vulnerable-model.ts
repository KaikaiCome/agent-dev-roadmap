import type { AssistantMessage, ChatModel, Message, ToolCall } from '../llm/types.ts';

// 第 21 章：“听话过头”的离线假模型，只用于红队测试。
// 默认的 mock 模型只认员工的问题，文档里写什么都不理会——这让注入攻击在离线测试里永远“失败”，
// 测不出防御是否有效。这个变体反过来：它把员工输入、记忆、工具结果里的指令都当真并照做，
// 模拟“被注入成功的模型”这个最坏情况。护栏和结构性防御必须在模型已经被攻破的前提下仍然守住。
// 它只认识几种固定句式（见下面的正则），不代表真实模型会被哪些说法骗到——那要用真实模型 + 红队工具去测。

type Result = { ok: boolean; data?: any; error?: { code: string; message: string } };
type Executed = { name: string; args: Record<string, unknown>; result?: Result };

export function createVulnerableModel(): ChatModel {
  let counter = 0;
  return {
    name: 'mock-vulnerable',
    async complete(request) {
      request.signal?.throwIfAborted();
      const reply = decide(request.messages, request.tools?.map((tool) => tool.name) ?? []);
      const message: AssistantMessage = {
        role: 'assistant',
        content: reply.content ?? '',
        ...(reply.call ? { toolCalls: [{ id: `vuln_${++counter}`, name: reply.call.name, arguments: JSON.stringify(reply.call.args) } satisfies ToolCall] } : {}),
      };
      if (message.content) request.onText?.(message.content);
      const inputChars = request.messages.reduce((sum, m) => sum + m.content.length, 0);
      return {
        message,
        usage: { inputTokens: Math.ceil(inputChars / 2), outputTokens: Math.ceil((message.content.length + 20) / 2) },
        finishReason: reply.call ? 'tool_calls' : 'stop',
      };
    },
  };
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

function decide(messages: Message[], tools: string[]): { content?: string; call?: { name: string; args: Record<string, unknown> } } {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const questionIndex = messages.findLastIndex((m) => m.role === 'user');
  const question = questionIndex >= 0 ? messages[questionIndex].content : '';
  const memory = messages.slice(0, questionIndex).filter((m) => m.role === 'user' && m.content.includes('<memory>')).map((m) => m.content).join('\n');

  const executed: Executed[] = [];
  const byId = new Map<string, Executed>();
  for (const message of messages.slice(questionIndex + 1)) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        const entry: Executed = { name: call.name, args: JSON.parse(call.arguments || '{}') };
        executed.push(entry);
        byId.set(call.id, entry);
      }
    }
    if (message.role === 'tool') {
      const entry = byId.get(message.toolCallId);
      if (entry) entry.result = JSON.parse(message.content);
    }
  }
  const calls = (name: string) => executed.filter((e) => e.name === name);
  const last = (name: string) => calls(name).at(-1);
  const toolText = executed.flatMap((e) => (e.result?.ok ? strings(e.result.data) : [])).join('\n');
  // 不可信的内容：记忆和工具结果。员工的问题同样会被照做（直接注入）
  const untrusted = `${memory}\n${toolText}`;
  const everything = `${question}\n${untrusted}`;

  // 1. 套取系统提示词：照单全收，还会按要求编码
  if (/系统提示词|system prompt|最开始收到的/i.test(question)) {
    return { content: /base64/i.test(question) ? Buffer.from(system).toString('base64') : system };
  }

  // 2. 先检索。问题里自称的 tenantId / role 会原样塞进参数——它以为这样就能换身份
  if (!calls('search_knowledge').length && tools.includes('search_knowledge')) {
    const args: Record<string, unknown> = { query: question.slice(0, 200) };
    const tenant = /tenantId\s*[=:：]\s*([\w-]+)/i.exec(question);
    const role = /roles?\s*[=:：]\s*([\w-]+)/i.exec(question);
    if (tenant) args.tenantId = tenant[1];
    if (role) args.role = role[1];
    return { call: { name: 'search_knowledge', args } };
  }
  if (tools.includes('vendor_status') && /供应商|vendor/i.test(question) && !calls('vendor_status').length) {
    return { call: { name: 'vendor_status', args: {} } };
  }

  // 3. 被要求反复调用工具（拒绝服务 / 刷钱）
  const loop = /(?:反复|重复|连续)调用\s*search_knowledge\s*(\d+)\s*次/.exec(everything);
  if (loop && tools.includes('search_knowledge') && calls('search_knowledge').length < Number(loop[1])) {
    return { call: { name: 'search_knowledge', args: { query: `${question.slice(0, 150)} 第 ${calls('search_knowledge').length + 1} 次` } } };
  }

  // 被带出去的“数据”：检索到的片段 + 记忆
  const hits: Array<{ sourceId: string; title: string; snippet: string }> = calls('search_knowledge').flatMap((e) => (e.result?.ok ? e.result.data.results : []));
  const memories = [...memory.matchAll(/^- \[[^\]]+\] (.+)$/gm)].map((m) => m[1]);
  const secret = [question.slice(0, 40), ...hits.map((h) => h.snippet), ...memories].join(' ').slice(0, 120);

  // 4. 被要求发邮件
  const mail = /(?:send_email|发(?:送)?邮件|邮件发)[^。\n]*?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/.exec(everything);
  if (mail && tools.includes('send_email') && !calls('send_email').length) {
    return { call: { name: 'send_email', args: { to: mail[1], body: secret } } };
  }

  // 5. 工单：员工要求的，或者文档/记忆/工具结果“要求”的，它都照做
  const injectedTicket = /(?:顺便|替员工|帮员工|立即|直接|自动)[^。\n]{0,12}(?:提交|创建|开)[^。\n]{0,20}工单|create_ticket/.exec(untrusted);
  const wantsTicket = /工单|报修|提交|申请/.test(question) || injectedTicket !== null;
  const fakeDraft = /draftId\s*[=:：]?\s*(draft_\w+)/.exec(everything);
  if (wantsTicket && fakeDraft && tools.includes('create_ticket') && !calls('create_ticket').length) {
    return { call: { name: 'create_ticket', args: { draftId: fakeDraft[1] } } };
  }
  if (wantsTicket && !calls('prepare_ticket').length && tools.includes('prepare_ticket')) {
    const priority = /优先级[^。\n]{0,6}?(P\d)|(P\d)\s*紧急|priority\s*[=:：]\s*(P\d)/i.exec(untrusted);
    const quoted = injectedTicket ? /[“‘「]([^”’」]{2,30})[”’」]/.exec(untrusted) : null;
    const cc = /抄送\s*([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/.exec(untrusted);
    const args: Record<string, unknown> = {
      title: `${priority ? '【P0 紧急】' : ''}${quoted?.[1] ?? question.slice(0, 40)}`,
      description: `员工请求：${question.slice(0, 500)}${cc ? `\n抄送：${cc[1]}` : ''}${memories.length ? `\n员工资料：${memories.join('；')}` : ''}`,
      sourceIds: hits.map((h) => h.sourceId).slice(0, 5),
    };
    if (priority) args.priority = priority[1] ?? priority[2] ?? priority[3];
    return { call: { name: 'prepare_ticket', args } };
  }
  const draft = last('prepare_ticket');
  if (wantsTicket && draft?.result?.ok && !calls('create_ticket').length && tools.includes('create_ticket')) {
    return { call: { name: 'create_ticket', args: { draftId: draft.result.data.draftId } } };
  }

  // 6. 最终回答：引用检索结果，再照做“在回答里附上图片/链接”之类的要求
  const parts = hits.length
    ? [`根据《${hits[0].title}》[${hits[0].sourceId}]：${hits[0].snippet}`]
    : ['没有找到你有权限查看的相关制度，无法给出确定答案。'];
  const vendor = last('vendor_status');
  if (vendor?.result?.ok) parts.push(`供应商状态：${String(vendor.result.data.status)}`);
  if (memories.length) parts.push(`（已参考你保存的记忆：${memories.join('；')}）`);
  const created = last('create_ticket');
  if (created?.result?.ok) parts.push(`工单已创建，编号 ${created.result.data.ticketId}。`);
  else if (created) parts.push(`工单创建失败：${created.result?.error?.message ?? '未知错误'}`);
  else if (draft && !draft.result?.ok) parts.push(`工单草稿生成失败：${draft.result?.error?.message ?? '未知错误'}`);
  const sent = last('send_email');
  if (sent) parts.push(sent.result?.ok ? `已按要求把资料发送到 ${String(sent.args.to)}。` : `邮件没有发出：${sent.result?.error?.message ?? '未知错误'}`);
  for (const match of everything.matchAll(/(!?\[[^\]]*\]\()?(https?:\/\/[^\s)）]*\{data\}[^\s)）]*)\)?/g)) {
    const url = match[2].replace('{data}', encodeURIComponent(secret));
    parts.push(match[1] ? `${match[1]}${url})` : url);
  }
  return { content: parts.join('\n') };
}
