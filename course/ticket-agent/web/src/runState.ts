import type { AgentEvent, RunStatus } from '../../src/events.ts';

// 前端状态完全由服务端事件推导。断线重连会重复收到事件，所以按 seq 去重；
// 文字增量（delta）只用于“打字机”效果，收到完整的 assistant_message 后丢弃。
export interface RunState {
  events: AgentEvent[];
  lastSeq: number;
  streamingText: string;
}

export type RunAction = { type: 'event'; event: AgentEvent } | { type: 'delta'; text: string } | { type: 'reset' };

export const initialRunState: RunState = { events: [], lastSeq: 0, streamingText: '' };

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'reset':
      return initialRunState;
    case 'delta':
      return { ...state, streamingText: state.streamingText + action.text };
    case 'event': {
      if (action.event.seq <= state.lastSeq) return state;
      return {
        events: [...state.events, action.event],
        lastSeq: action.event.seq,
        streamingText: action.event.type === 'assistant_message' ? '' : state.streamingText,
      };
    }
  }
}

export interface ToolCard {
  callId: string;
  name: string;
  state: 'running' | 'ok' | 'error';
  detail?: string;
}

export interface RunView {
  question: string;
  status: RunStatus;
  tools: ToolCard[];
  approval?: { callId: string; summary: string; expiresAt: string };
  answer: string;
  reason?: string;
}

/** 把事件列表转换成界面需要的结构 */
export function toView(state: RunState): RunView {
  const view: RunView = { question: '', status: 'running', tools: [], answer: '' };
  const cards = new Map<string, ToolCard>();
  for (const event of state.events) {
    switch (event.type) {
      case 'run_started':
        view.question = event.data.question;
        break;
      case 'assistant_message':
        if (event.data.content) view.answer = event.data.content;
        break;
      case 'tool_started':
        cards.set(event.data.callId, { callId: event.data.callId, name: event.data.name, state: 'running' });
        break;
      case 'tool_finished':
        cards.set(event.data.callId, {
          callId: event.data.callId,
          name: event.data.name,
          state: event.data.ok ? 'ok' : 'error',
          detail: event.data.ok ? undefined : event.data.error?.message,
        });
        break;
      case 'approval_requested':
        view.status = 'waiting_approval';
        view.approval = { callId: event.data.callId, summary: event.data.summary, expiresAt: event.data.expiresAt };
        break;
      case 'approval_resolved':
        view.status = 'running';
        view.approval = undefined;
        break;
      case 'run_finished':
        view.status = event.data.status;
        view.reason = event.data.reason;
        view.approval = undefined;
        break;
    }
  }
  view.tools = [...cards.values()];
  // 模型正在输出时，先显示增量文字
  if (state.streamingText) view.answer = state.streamingText;
  return view;
}
