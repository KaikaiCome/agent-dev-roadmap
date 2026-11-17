import type { Message } from '../llm/types.ts';
import type { JsonSchema } from './schema.ts';

// 第 24 章：结构化输出的演示任务——把员工的一句话分诊成工单字段。
// schema 按 OpenAI strict 模式的要求写：所有字段 required、additionalProperties: false、根是 object。
// maxLength 不在 OpenAI 文档列出的 strict 支持关键字里，服务端不保证它，本地校验必须兜底。
export const triageSchema: JsonSchema = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['it', 'hr', 'finance', 'admin'], description: '归属部门' },
    priority: { type: 'string', enum: ['low', 'medium', 'high'] },
    title: { type: 'string', maxLength: 30, description: '工单标题，不超过 30 字' },
    needsHuman: { type: 'boolean', description: '是否需要人工处理（报修、申请等）' },
  },
  required: ['category', 'priority', 'title', 'needsHuman'],
  additionalProperties: false,
};

export interface Triage {
  category: 'it' | 'hr' | 'finance' | 'admin';
  priority: 'low' | 'medium' | 'high';
  title: string;
  needsHuman: boolean;
}

export function triageMessages(question: string): Message[] {
  return [
    {
      role: 'system',
      content: '把员工的问题分诊成工单字段。只输出一个 JSON 对象，字段：category（it/hr/finance/admin）、priority（low/medium/high）、title（≤30 字）、needsHuman（布尔）。不要输出解释或代码块。',
    },
    { role: 'user', content: question },
  ];
}

/** 每条输入的正确分类。schema 只能保证“格式对”，分类对不对要靠这样的标注去评 */
export const triageInputs: Array<{ question: string; category: Triage['category'] }> = [
  { question: 'VPN 连不上，帮我报修', category: 'it' },
  { question: '电脑开不了机，今天要交方案，很紧急', category: 'it' },
  { question: '请问邮箱密码怎么重置？', category: 'it' },
  { question: '打印机卡纸了，帮我提交工单', category: 'it' },
  { question: '出差的发票丢了还能报销吗？', category: 'finance' },
  { question: '帮我申请采购一台显示器，预算 1500 元', category: 'finance' },
  { question: '上个月的报销款还没到账', category: 'finance' },
  { question: '年假还剩几天？', category: 'hr' },
  { question: '帮我申请下周三请假一天', category: 'hr' },
  { question: '工资条里的社保扣款不对', category: 'hr' },
  { question: '会议室的投影仪坏了，帮我报修', category: 'admin' },
  { question: '工位的椅子坏了，马上要换', category: 'admin' },
];
