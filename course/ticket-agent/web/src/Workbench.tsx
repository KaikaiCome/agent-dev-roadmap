import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api.ts';
import { toView, type RunView } from './runState.ts';
import { useRunEvents, type Connection } from './useRunEvents.ts';

const toolLabels: Record<string, string> = {
  search_knowledge: '检索制度文档',
  prepare_ticket: '生成工单草稿',
  create_ticket: '提交工单',
};

const statusLabels: Record<RunView['status'], string> = {
  running: '处理中…',
  waiting_approval: '等待你确认',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  budget_exceeded: '超出预算，已停止',
};

const connectionLabels: Partial<Record<Connection, string>> = {
  reconnecting: '连接中断，正在自动重连…（服务重启时也会这样，不会丢失进度）',
  failed: '事件流被服务端拒绝：登录可能已过期，请重新选择身份后刷新页面',
};

export function Workbench() {
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [question, setQuestion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 发起过的任务都留在列表里：一个在等审批时再提问，之前的任务不会“消失”
  const [history, setHistory] = useState<Array<{ id: string; question: string }>>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const { run, connection } = useRunEvents(runId);

  useEffect(() => {
    api.users().then(setUsers).catch(() => setError('连接不到 Agent 服务，请先运行 npm run server'));
    api.me().then(setMe).catch(() => undefined);
  }, []);

  const guard = (action: () => Promise<unknown>) => () => {
    setError('');
    action().catch((e: Error) => {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        setError('登录已过期（服务重启后演示会话会清空），请重新选择身份');
      } else setError(e.message);
    });
  };

  const submit = guard(async () => {
    setSubmitting(true);
    try {
      const text = question.trim();
      const { runId: id } = await api.createRun(text);
      setHistory((list) => [{ id, question: text }, ...list].slice(0, 10));
      setRunId(id);
      setQuestion('');
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <main className="wb">
      <h1>企业知识库与工单 Agent</h1>
      <div className="row">
        <label>
          当前身份：
          <select
            value={me?.id ?? ''}
            onChange={(e) => guard(async () => { setMe(await api.login(e.target.value)); setRunId(null); setHistory([]); })()}
          >
            <option value="" disabled>选择演示账号</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
      </div>

      {me && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); if (question.trim() && !submitting) submit(); }}>
          <textarea
            aria-label="问题"
            value={question}
            maxLength={2000}
            placeholder="例如：出差住宿每晚能报销多少？/ VPN 连不上，帮我提交 IT 工单"
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button type="submit" disabled={!question.trim() || submitting}>{submitting ? '发送中…' : '发送'}</button>
        </form>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      {history.length > 1 && (
        <nav className="row" aria-label="最近的任务">
          {history.map((item) => (
            <button key={item.id} aria-pressed={item.id === runId} onClick={() => setRunId(item.id)}>
              {item.question.slice(0, 12)}
            </button>
          ))}
        </nav>
      )}

      {runId && (
        <RunPanel
          view={toView(run)}
          connection={connection}
          onApprove={(callId, approved) => guard(() => api.approve(runId, callId, approved))()}
          onCancel={guard(() => api.cancel(runId))}
        />
      )}
    </main>
  );
}

export function RunPanel({ view, connection, onApprove, onCancel }: {
  view: RunView;
  connection?: Connection;
  onApprove: (callId: string, approved: boolean) => void;
  onCancel: () => void;
}) {
  const active = view.status === 'running' || view.status === 'waiting_approval';
  const notice = connection && active ? connectionLabels[connection] : undefined;
  return (
    <section aria-label="运行结果">
      {notice && <p className="error" role="status">{notice}</p>}
      {view.question && <div className="card"><strong>你：</strong>{view.question}</div>}

      {view.tools.map((tool) => (
        <div key={tool.callId} className="card tool">
          {tool.state === 'running' ? '⏳' : tool.state === 'ok' ? '✅' : '⚠️'} {toolLabels[tool.name] ?? tool.name}
          {tool.detail && <span>：{tool.detail}</span>}
        </div>
      ))}

      {view.approval && (
        <div className="card approval" role="dialog" aria-label="操作确认">
          <strong>Agent 请求执行以下操作，需要你确认：</strong>
          {/* 摘要按纯文本渲染：内容可能来自模型，不能当 HTML 插入 */}
          <pre>{view.approval.summary}</pre>
          <div className="row">
            <button onClick={() => onApprove(view.approval!.callId, true)}>确认执行</button>
            <button onClick={() => onApprove(view.approval!.callId, false)}>拒绝</button>
          </div>
        </div>
      )}

      {view.answer && <div className="card answer"><strong>Agent：</strong>{view.answer}</div>}

      <div className="row">
        <span>状态：{statusLabels[view.status]}{view.reason ? `（${view.reason}）` : ''}</span>
        {active && <button onClick={onCancel}>取消</button>}
      </div>
    </section>
  );
}
