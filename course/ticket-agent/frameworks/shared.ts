import type { User } from '../src/data/seed.ts';
import type { Store } from '../src/store.ts';
import { createTools } from '../src/tools/index.ts';
import { ToolError, type Tool, type ToolContext } from '../src/tools/types.ts';

// 两个框架版本共用的“业务层”：工具的权限过滤、草稿归属、幂等建单全部来自 ../src，框架只负责编排。
// 这样三种实现（手写、Agents SDK、LangGraph）的差别只剩编排方式，对比才公平。

/** 服务端注入、绝不来自模型参数的身份信息。runId 对应 Store 里的一个 run，草稿和工单都挂在它下面 */
export interface TicketContext {
  user: User;
  runId: string;
}

export const REJECTED = envelope({ ok: false, error: { code: 'APPROVAL_REJECTED', message: '员工拒绝了这个操作，操作未执行' } });

/** 每个对话（线程）在 Store 里对应一个 run，框架的 thread/会话 id 直接用它 */
export function startConversation(store: Store, user: User, title: string): TicketContext {
  return { user, runId: store.createRun(user, title).id };
}

export function referenceTools(store: Store): Map<string, Tool> {
  return new Map(createTools(store).map((tool) => [tool.spec.name, tool]));
}

/**
 * 执行参考项目的工具，并把结果包成手写版 toModelMessages 里同样的信封：{ ok, data } 或 { ok: false, error }。
 * 模型看到的工具结果与手写版逐字相同，同一个假模型才能驱动三种实现。
 */
export async function runReferenceTool(tool: Tool, args: unknown, context: TicketContext & { callId: string; signal?: AbortSignal }): Promise<string> {
  const toolContext: ToolContext = { user: context.user, runId: context.runId, callId: context.callId, signal: context.signal ?? new AbortController().signal };
  try {
    const parsed = tool.parse(args);
    return envelope({ ok: true, data: await tool.run(parsed, toolContext) });
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return envelope({ ok: false, error: { code: error.code, message: error.message } });
  }
}

/** 审批界面上给人看的说明，复用参考项目 create_ticket 的 describe（会校验草稿归属） */
export function approvalSummary(tool: Tool, args: unknown, context: TicketContext & { callId: string }): string {
  const fallback = `${tool.spec.name} ${JSON.stringify(args)}（参数不合法，确认后也会失败）`;
  try {
    return tool.describe?.(tool.parse(args), { ...context, signal: new AbortController().signal }) ?? fallback;
  } catch (error) {
    if (error instanceof ToolError) return fallback;
    throw error;
  }
}

/** 字段说明直接取参考项目工具的 JSON Schema，避免两份 schema 的描述各改各的 */
export function fieldDescription(tool: Tool, field: string): string {
  const properties = tool.spec.parameters.properties as Record<string, { description?: string }>;
  const description = properties[field]?.description;
  if (!description) throw new Error(`${tool.spec.name}.${field} 没有说明`);
  return description;
}

function envelope(value: unknown): string {
  return JSON.stringify(value);
}
