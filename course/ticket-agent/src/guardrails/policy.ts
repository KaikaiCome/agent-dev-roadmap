import type { User } from '../data/seed.ts';
import type { AgentEvent, GuardrailFinding } from '../events.ts';
import type { ToolCall } from '../llm/types.ts';
import type { Tool } from '../tools/types.ts';
import { hostAllowed } from './output.ts';

// 第 21 章：工具调用策略。它在参数校验之后、审批之前执行：违反策略的调用不会打扰员工确认，直接以错误结果返回给模型。
// 所有判断只依据可信输入——登录身份、员工原话、事件日志、工具定义——不依据模型说了什么、文档里写了什么。

export interface ToolPolicy {
  /** 角色 → 允许使用的工具。默认拒绝：没有列出的工具，任何人都不能调用 */
  roles: Record<string, readonly string[]>;
  /** 每个 run 内每个工具最多真正执行几次（被拦截的不算）。没有列出的工具不限 */
  maxCallsPerRun: Record<string, number>;
  /**
   * 有副作用的工具：员工原话必须表达过这个意图。
   * 这是 CaMeL 思路的简化版——“做不做写操作”只由可信的员工输入决定，文档和工具结果说什么都不算。
   */
  requiresIntent: Record<string, RegExp>;
  /** 参数里出现的网址必须在这些域名内 */
  allowedHosts: readonly string[];
  /** 参数里出现的邮箱必须是这些域名 */
  allowedEmailDomains: readonly string[];
  /** 写操作参数里出现这些“升级”字样时，员工原话里也必须出现，防止被注入抬高优先级 */
  escalation: RegExp;
}

const ticketIntent = /工单|报修|提交|申请/;

export const defaultToolPolicy: ToolPolicy = {
  roles: {
    employee: ['search_knowledge', 'research', 'prepare_ticket', 'create_ticket', 'remember'],
  },
  maxCallsPerRun: { search_knowledge: 3, research: 2, prepare_ticket: 2, create_ticket: 1, remember: 1 },
  requiresIntent: { prepare_ticket: ticketIntent, create_ticket: ticketIntent, remember: /记住/ },
  allowedHosts: ['intranet.acme.example'],
  allowedEmailDomains: ['acme.example'],
  escalation: /P[0-2]\b|紧急|加急|最高优先级|urgent/i,
};

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

export interface ToolCallInput {
  call: ToolCall;
  tool: Tool;
  /** 模型给出的原始参数（JSON 解析后、tool.parse 之前），用来发现 schema 之外的字段 */
  raw: unknown;
}

export interface ToolCallContext {
  user: User;
  /** 员工本次的原话（run_started），不是模型复述的版本 */
  question: string;
  events: AgentEvent[];
}

export function checkToolCall({ call, tool, raw }: ToolCallInput, { user, question, events }: ToolCallContext, policy: ToolPolicy): GuardrailFinding | undefined {
  const block = (rule: string, detail: string): GuardrailFinding => ({ stage: 'tool_call', rule, action: 'block', detail, callId: call.id });

  if (!user.roles.some((role) => policy.roles[role]?.includes(call.name))) {
    return block('tool_not_allowed', `角色 ${user.roles.join('/')} 不能使用 ${call.name}`);
  }

  // tool.parse 只取认识的字段、忽略多余的。多出来的 tenantId、priority 往往是攻击者在试探，宁可拒绝
  const known = Object.keys((tool.spec.parameters as { properties?: Record<string, unknown> }).properties ?? {});
  const unknown = raw && typeof raw === 'object' ? Object.keys(raw).filter((key) => !known.includes(key)) : [];
  if (unknown.length) return block('unknown_argument', `参数 ${unknown.join(', ')} 不在 ${call.name} 的定义中`);

  const limit = policy.maxCallsPerRun[call.name];
  if (limit !== undefined) {
    const used = events.filter((e) => e.type === 'tool_started' && e.data.name === call.name && e.data.callId !== call.id).length;
    if (used >= limit) return block('rate_limit', `${call.name} 本次 run 已执行 ${used} 次，上限 ${limit}`);
  }

  const intent = policy.requiresIntent[call.name];
  if (intent && !intent.test(question)) return block('no_user_intent', `员工没有要求执行 ${call.name}`);

  const values = strings(raw);
  for (const url of values.flatMap((v) => v.match(/\b(?:https?|ftp):\/\/[^\s<>"')\]]+/gi) ?? [])) {
    if (!hostAllowed(url, policy.allowedHosts)) return block('external_destination', `参数包含外部网址 ${url.slice(0, 60)}`);
  }
  for (const email of values.flatMap((v) => v.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [])) {
    const domain = email.split('@')[1].toLowerCase();
    if (!policy.allowedEmailDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) {
      return block('external_destination', `参数包含外部邮箱（${domain}）`);
    }
  }

  if (!tool.readOnly) {
    const claimed = values.flatMap((v) => v.match(new RegExp(policy.escalation.source, 'gi')) ?? []);
    const unrequested = claimed.filter((term) => !question.toLowerCase().includes(term.toLowerCase()));
    if (unrequested.length) return block('unrequested_escalation', `参数包含员工没有提出的优先级字样：${[...new Set(unrequested)].join('、')}`);
  }
  return undefined;
}
