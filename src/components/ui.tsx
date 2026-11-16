import { useState } from 'react';
import type { Task } from '../data/roadmap';
import type { Snippet } from '../data/snippets';
import { progress, useProgress } from '../progress';

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(value * 100);
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function TaskItem({ task }: { task: Task }) {
  const { done } = useProgress();
  const checked = Boolean(done[task.id]);
  return (
    <li className={checked ? 'task done' : 'task'}>
      <label>
        <input type="checkbox" checked={checked} onChange={() => progress.toggle(task.id)} />
        <span>
          {task.text}
          {task.detail && <small className="task-detail">{task.detail}</small>}
        </span>
      </label>
    </li>
  );
}

export function CodeBlock({ snippet }: { snippet: Snippet }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(snippet.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <section className="card">
      <div className="code-header">
        <h3>{snippet.title}</h3>
        <button type="button" onClick={copy}>{copied ? '已复制' : '复制代码'}</button>
      </div>
      <p className="muted">{snippet.description}</p>
      <pre className="code"><code>{snippet.code}</code></pre>
    </section>
  );
}
