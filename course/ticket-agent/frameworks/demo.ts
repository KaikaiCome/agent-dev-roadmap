import { setTraceProcessors, type Span } from '@openai/agents';
import { users } from '../src/data/seed.ts';
import { createMockModel } from '../src/llm/mock.ts';
import { agentsSdk, handRolled, langGraph, normalizeAnswer, type Step } from './compare.ts';

// 同一组对话交给三种实现：手写循环、OpenAI Agents SDK、LangGraph。全部离线，用参考项目的 mock 模型。

const [alice, , bob] = users;
const scenario: Step[] = [
  { user: alice, question: '差旅住宿报销上限是多少' },
  { user: alice, question: 'VPN 连不上，帮我提交工单', approve: true },
  { user: alice, question: '显示器坏了，申请报修', approve: false },
  { user: bob, question: '差旅住宿报销上限是多少' },
  { user: alice, question: 'Q4 预算冻结了吗' },
];

// Agents SDK 默认把追踪发到 OpenAI。离线演示换成本地收集器，只统计各类 span 的数量
const spans = new Map<string, number>();
setTraceProcessors([{
  async onTraceStart() {},
  async onTraceEnd() {},
  async onSpanStart() {},
  async onSpanEnd(span: Span<any>) {
    const key = span.spanData.type === 'function' ? `function:${span.spanData.name}` : span.spanData.type;
    spans.set(key, (spans.get(key) ?? 0) + 1);
  },
  async shutdown() {},
  async forceFlush() {},
}]);

const implementations = { '手写（src/agent.ts）': handRolled, 'OpenAI Agents SDK': agentsSdk, 'LangGraph.js': langGraph };
const results = [];
for (const [name, implementation] of Object.entries(implementations)) {
  results.push({ name, ...(await implementation(scenario, createMockModel())) });
}

console.log('对话记录（三种实现逐字相同时只打印一份）：\n');
for (const [i, turn] of results[0].turns.entries()) {
  console.log(`[${turn.user}] ${turn.question}`);
  if (turn.approval) console.log(`  审批：${turn.approval.split('\n')[0]} → ${scenario[i].approve ? '同意' : '拒绝'}`);
  console.log(`  回答：${turn.answer.split('\n').join('\n        ')}`);
}

console.log('\n实现                  回答一致  模型调用  输入 token  工单');
const baseline = results[0].turns.map((turn) => normalizeAnswer(turn.answer));
for (const result of results) {
  const same = result.turns.every((turn, i) => normalizeAnswer(turn.answer) === baseline[i]);
  console.log(`${result.name.padEnd(20)}  ${(same ? '是' : '否').padEnd(6)}  ${String(result.modelCalls).padStart(6)}  ${String(result.inputTokens).padStart(9)}  ${result.tickets}`);
}

console.log(`\nAgents SDK 追踪 span：${[...spans].map(([key, count]) => `${key}×${count}`).join('  ')}`);
