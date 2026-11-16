import type { User } from '../data/seed.ts';
import type { ToolSpec } from '../llm/types.ts';

/** 执行工具时由服务端注入的上下文。身份来自登录会话，绝不来自模型参数 */
export interface ToolContext {
  user: User;
  runId: string;
  callId: string;
  signal: AbortSignal;
}

export interface Tool<Args = any> {
  spec: ToolSpec;
  /** true = 执行前必须由用户在界面上确认（有副作用的写操作） */
  requiresApproval?: boolean;
  /** true = 只读、无副作用。同一轮里的多个只读调用会并发执行 */
  readOnly?: boolean;
  /** 校验并转换模型给出的参数。不合法时抛出 ToolError */
  parse(args: unknown): Args;
  run(args: Args, context: ToolContext): unknown | Promise<unknown>;
  /** 给审批界面看的人类可读说明 */
  describe?(args: Args, context: ToolContext): string;
}

/** 可预期的业务错误：会作为工具结果回传给模型，让它调整做法 */
export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

export function asObject(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ToolError('INVALID_ARGUMENTS', '参数必须是 JSON 对象');
  }
  return args as Record<string, unknown>;
}

export function requireString(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError('INVALID_ARGUMENTS', `${key} 必须是非空字符串`);
  }
  if (value.length > maxLength) {
    throw new ToolError('INVALID_ARGUMENTS', `${key} 不能超过 ${maxLength} 个字符`);
  }
  return value.trim();
}

export function optionalStringArray(args: Record<string, unknown>, key: string, maxItems: number): string[] {
  const value = args[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === 'string')) {
    throw new ToolError('INVALID_ARGUMENTS', `${key} 必须是最多 ${maxItems} 个字符串的数组`);
  }
  return value;
}
