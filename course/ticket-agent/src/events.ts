import type { ToolCall } from './llm/types.ts';

// 一次 run = 员工提出一个请求后 Agent 的完整处理过程。
// 过程中的每件事都记录成一条事件（只追加、不修改），它是唯一事实来源：
// 发给模型的历史、前端界面、审计、崩溃恢复，全部从事件推导出来。

export type RunStatus = 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | 'budget_exceeded';

export const terminalStatuses: RunStatus[] = ['completed', 'failed', 'cancelled', 'budget_exceeded'];

export interface ToolFailure {
  code: string;
  message: string;
}

export interface EventData {
  run_started: { question: string; userId: string };
  assistant_message: { content: string; toolCalls: ToolCall[] };
  tool_started: { callId: string; name: string; args: unknown };
  tool_finished: { callId: string; name: string; ok: boolean; result?: unknown; error?: ToolFailure };
  approval_requested: { callId: string; name: string; args: unknown; summary: string; expiresAt: string };
  approval_resolved: { callId: string; approved: boolean; userId: string; reason?: 'expired' };
  usage: { model: string; inputTokens: number; outputTokens: number; latencyMs: number; estimated?: boolean };
  run_finished: { status: Exclude<RunStatus, 'running' | 'waiting_approval'>; reason?: string };
  /** 发给模型的视图里，这些工具结果从此用占位说明代替。只影响视图，原始结果仍在日志中 */
  context_trimmed: { callIds: string[]; tokens: number };
}

export type EventType = keyof EventData;

export type AgentEvent = {
  [K in EventType]: { runId: string; seq: number; type: K; data: EventData[K]; createdAt: string };
}[EventType];
