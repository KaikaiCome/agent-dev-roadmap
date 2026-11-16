import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/events.ts';
import { initialRunState, runReducer, toView, type RunState } from './runState.ts';
import { RunPanel } from './Workbench.tsx';

const at = '2026-01-01T00:00:00.000Z';
const events: AgentEvent[] = [
  { runId: 'r', seq: 1, type: 'run_started', data: { question: 'VPN 连不上', userId: 'alice' }, createdAt: at },
  { runId: 'r', seq: 2, type: 'tool_started', data: { callId: 'c1', name: 'search_knowledge', args: {} }, createdAt: at },
  { runId: 'r', seq: 3, type: 'tool_finished', data: { callId: 'c1', name: 'search_knowledge', ok: true, result: {} }, createdAt: at },
  {
    runId: 'r', seq: 4, type: 'approval_requested',
    data: { callId: 'c2', name: 'create_ticket', args: {}, summary: '提交工单「<img src=x onerror=alert(1)>」', expiresAt: at },
    createdAt: at,
  },
];

const replay = (list: AgentEvent[], state: RunState = initialRunState) =>
  list.reduce((s, event) => runReducer(s, { type: 'event', event }), state);

afterEach(cleanup);

describe('工作台状态', () => {
  it('断线重连收到的重复事件会被忽略', () => {
    const once = replay(events);
    const twice = replay(events, once);
    expect(twice.events).toHaveLength(4);
    expect(twice).toBe(once);
  });

  it('流式文字在完整消息到达后被替换', () => {
    let state = runReducer(initialRunState, { type: 'delta', text: '根据' });
    expect(toView(state).answer).toBe('根据');
    state = runReducer(state, { type: 'event', event: { runId: 'r', seq: 1, type: 'assistant_message', data: { content: '根据制度…', toolCalls: [] }, createdAt: at } });
    expect(state.streamingText).toBe('');
    expect(toView(state).answer).toBe('根据制度…');
  });

  it('审批卡片按纯文本显示摘要，并把决定回传', async () => {
    const onApprove = vi.fn();
    render(<RunPanel view={toView(replay(events))} onApprove={onApprove} onCancel={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: '操作确认' });
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(screen.getByText(/检索制度文档/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onApprove).toHaveBeenCalledWith('c2', false);
  });

  it('审批处理后卡片消失，结束后不再显示取消按钮', () => {
    const resolved = replay([
      { runId: 'r', seq: 5, type: 'approval_resolved', data: { callId: 'c2', approved: false, userId: 'alice' }, createdAt: at },
      { runId: 'r', seq: 6, type: 'run_finished', data: { status: 'completed' }, createdAt: at },
    ], replay(events));
    render(<RunPanel view={toView(resolved)} onApprove={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    expect(screen.getByText(/已完成/)).toBeTruthy();
  });

  it('事件流被拒绝时提示重新登录，结束后的 run 不显示连接提示', () => {
    const view = toView(replay(events));
    const { rerender } = render(<RunPanel view={view} connection="failed" onApprove={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('status').textContent).toMatch(/重新选择身份/);
    const finished = replay([{ runId: 'r', seq: 5, type: 'run_finished', data: { status: 'cancelled' }, createdAt: at }], replay(events));
    rerender(<RunPanel view={toView(finished)} connection="failed" onApprove={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
