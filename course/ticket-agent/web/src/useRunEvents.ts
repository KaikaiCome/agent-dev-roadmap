import { useEffect, useReducer, useState } from 'react';
import type { AgentEvent } from '../../src/events.ts';
import { initialRunState, runReducer } from './runState.ts';

/** open = 已连接；reconnecting = 断线后浏览器正在自动重连；failed = 服务端拒绝（未登录、无权限等），不会再重连 */
export type Connection = 'connecting' | 'open' | 'reconnecting' | 'failed' | 'done';

/**
 * 订阅一个 run 的事件流。EventSource 断线会自动重连，并带上 Last-Event-ID，
 * 服务端从断点继续推送，所以刷新页面、网络抖动或服务重启都不会丢事件。
 */
export function useRunEvents(runId: string | null) {
  const [state, dispatch] = useReducer(runReducer, initialRunState);
  // 记录是哪个 run 的连接状态；切换 run 时旧状态自然失效，不需要在 effect 里同步重置
  const [conn, setConn] = useState<{ runId: string | null; value: Connection }>({ runId: null, value: 'connecting' });

  useEffect(() => {
    dispatch({ type: 'reset' });
    if (!runId) return;
    const setConnection = (value: Connection) => setConn({ runId, value });
    const source = new EventSource(`/api/runs/${runId}/events`, { withCredentials: true });
    source.onopen = () => setConnection('open');
    source.onerror = () => {
      // 服务端返回非 200（401/404/429）时 EventSource 会直接关闭且不再重试；网络断开则处于 CONNECTING 并自动重连
      setConnection(source.readyState === EventSource.CLOSED ? 'failed' : 'reconnecting');
    };
    source.addEventListener('agent', (message) => {
      const event = JSON.parse(message.data) as AgentEvent;
      dispatch({ type: 'event', event });
      // 结束后主动关闭，否则浏览器会不停自动重连
      if (event.type === 'run_finished') {
        source.close();
        setConnection('done');
      }
    });
    source.addEventListener('delta', (message) => dispatch({ type: 'delta', text: JSON.parse(message.data).text }));
    return () => source.close();
  }, [runId]);

  return { run: state, connection: conn.runId === runId ? conn.value : 'connecting' as Connection };
}
