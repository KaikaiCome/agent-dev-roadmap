// 第 2 章：不到 70 行的最小 Agent 循环，只用来理解原理。
// 运行：npm run mini -- "差旅住宿报销上限是多少？"
// 正式项目在 src/agent.ts 中补齐了权限、审批、持久化、预算和恢复。
import { loadConfig } from '../src/config.ts';
import { createModel } from '../src/llm/index.ts';
import type { Message, ToolSpec } from '../src/llm/types.ts';

// 1. 告诉模型有哪些工具。description 是写给模型看的“使用说明”
const tools: ToolSpec[] = [{
  name: 'search_knowledge',
  description: '检索公司制度文档。回答任何制度问题前都要先调用。',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: '检索关键词或问题' } },
    required: ['query'],
  },
}];

// 2. 工具的真正实现：普通函数。这里用写死的数据代替数据库，按关键词匹配
const docs = [
  { sourceId: 'demo-expense@v1', title: '差旅报销制度', keywords: ['差旅', '住宿', '报销'], snippet: '住宿每晚上限 500 元。' },
  { sourceId: 'demo-vpn@v1', title: 'VPN 指南', keywords: ['vpn', '网络'], snippet: 'VPN 连不上先重启客户端。' },
];
function searchKnowledge(args: { query: string }) {
  const query = args.query.toLowerCase();
  const results = docs
    .filter((doc) => doc.keywords.some((word) => query.includes(word)))
    .map(({ sourceId, title, snippet }) => ({ sourceId, title, snippet }));
  return { ok: true, data: { query: args.query, results } };
}

const model = createModel(loadConfig());
const messages: Message[] = [
  { role: 'system', content: '你是企业制度助手。只根据工具返回的内容回答，并注明来源编号。' },
  { role: 'user', content: process.argv[2] ?? '差旅住宿报销上限是多少？' },
];

// 3. Agent 循环：问模型 → 模型要用工具就执行 → 把结果放回对话 → 再问，直到它直接回答
for (let step = 1; step <= 5; step++) {
  const { message } = await model.complete({ messages, tools });
  messages.push(message);

  if (!message.toolCalls?.length) {
    console.log(`\n[第 ${step} 步] 最终回答：\n${message.content}`);
    process.exit(0);
  }

  for (const call of message.toolCalls) {
    console.log(`[第 ${step} 步] 模型请求调用 ${call.name}，参数 ${call.arguments}`);
    let result: unknown;
    try {
      // 模型给的参数可能不是合法 JSON，也可能缺字段：出错要告诉模型，而不是让程序崩溃
      const args = JSON.parse(call.arguments);
      if (call.name !== 'search_knowledge' || typeof args.query !== 'string') throw new Error('未知工具或参数错误');
      result = searchKnowledge(args);
    } catch (error) {
      result = { ok: false, error: { code: 'INVALID_CALL', message: (error as Error).message } };
    }
    console.log(`[第 ${step} 步] 工具返回 ${JSON.stringify(result)}`);
    // tool 消息必须带上对应的 toolCallId，模型才知道这是哪次调用的结果
    messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
  }
}

// 4. 一定要有步数上限，防止模型反复调用工具、无限消耗费用
console.log('达到最大步数 5，停止。');
