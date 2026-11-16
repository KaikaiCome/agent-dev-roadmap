import { useRef } from 'react';
import { allTaskIds, masteryCriteria, pillars, stages, stageTaskIds, type Stage } from '../data/roadmap';
import { snippets } from '../data/snippets';
import { parseProgress, progress, ratio, useProgress } from '../progress';
import { href } from '../router';
import { CodeBlock, ProgressBar, TaskItem } from './ui';

export function Home() {
  const { done } = useProgress();
  const overall = ratio(done, allTaskIds);
  return (
    <>
      <header className="hero">
        <h1>React 高级开发者的 Agent 精通路线</h1>
        <p>按每周 8–10 小时估算，约 5 个月。把 React 能力用在 Agent 界面上，同时补齐循环、上下文、工具、安全与评估能力。</p>
        <div className="overall">
          <ProgressBar value={overall} label="总进度" />
          <span>总进度 {Math.round(overall * 100)}%</span>
        </div>
      </header>

      <section>
        <h2>“精通”指什么</h2>
        <div className="grid">
          {pillars.map((p, i) => (
            <div className="card pillar" key={p.title}>
              <span className="pillar-index">{i + 1}</span>
              <h3>{p.title}</h3>
              <p>{p.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>学习阶段</h2>
        <ol className="stage-list">
          {stages.map((s) => {
            const r = ratio(done, stageTaskIds(s));
            return (
              <li key={s.id}>
                <a className="card stage-card" href={href({ page: 'stage', id: s.id })}>
                  <div className="stage-card-head">
                    <span className="badge">阶段 {s.index}</span>
                    <span className="muted">{s.weeks}</span>
                  </div>
                  <h3>{s.title}</h3>
                  <p>{s.goal}</p>
                  <ProgressBar value={r} label={`${s.title} 进度`} />
                </a>
              </li>
            );
          })}
        </ol>
      </section>

      <BackupPanel />
    </>
  );
}

function BackupPanel() {
  const fileInput = useRef<HTMLInputElement>(null);
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(progress.get(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'agent-roadmap-progress.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = async (file: File) => {
    const parsed = parseProgress(await file.text());
    if (!parsed) {
      alert('文件格式无效');
      return;
    }
    progress.replace(parsed);
  };
  return (
    <section className="card backup">
      <h2>进度备份</h2>
      <p className="muted">进度和笔记只保存在本浏览器的 localStorage 中。</p>
      <div className="actions">
        <button type="button" onClick={exportJson}>导出 JSON</button>
        <button type="button" onClick={() => fileInput.current?.click()}>导入 JSON</button>
        <button
          type="button"
          className="danger"
          onClick={() => { if (confirm('确定清空全部进度和笔记？')) progress.reset(); }}
        >
          清空
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importJson(file);
            e.target.value = '';
          }}
        />
      </div>
    </section>
  );
}

export function StageView({ stage }: { stage: Stage }) {
  const { done, notes } = useProgress();
  const ids = stageTaskIds(stage);
  const r = ratio(done, ids);
  const prev = stages[stage.index - 1];
  const next = stages[stage.index + 1];
  const snippet = stage.snippetId ? snippets[stage.snippetId] : undefined;

  return (
    <article>
      <header className="stage-header">
        <span className="badge">阶段 {stage.index} · {stage.weeks}</span>
        <h1>{stage.title}</h1>
        <p className="goal">{stage.goal}</p>
        <div className="overall">
          <ProgressBar value={r} label={`${stage.title} 进度`} />
          <span>{ids.filter((id) => done[id]).length} / {ids.length}</span>
        </div>
      </header>

      {stage.groups.map((g) => (
        <section className="card" key={g.title}>
          <h2>{g.title}</h2>
          <ul className="tasks">
            {g.tasks.map((t) => <TaskItem key={t.id} task={t} />)}
          </ul>
        </section>
      ))}

      <section className="card deliverable">
        <h2>阶段产出</h2>
        <p>{stage.deliverable}</p>
      </section>

      {snippet && <CodeBlock snippet={snippet} />}

      <section className="card">
        <h2>参考资源</h2>
        <ul className="resources">
          {stage.resources.map((res) => (
            <li key={res.url}><a href={res.url} target="_blank" rel="noreferrer">{res.title}</a></li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2><label htmlFor={`notes-${stage.id}`}>学习笔记</label></h2>
        <textarea
          id={`notes-${stage.id}`}
          rows={6}
          placeholder="记录踩坑、失败案例和结论……"
          value={notes[stage.id] ?? ''}
          onChange={(e) => progress.setNote(stage.id, e.target.value)}
        />
      </section>

      <nav className="pager">
        {prev ? <a href={href({ page: 'stage', id: prev.id })}>← {prev.title}</a> : <span />}
        {next
          ? <a href={href({ page: 'stage', id: next.id })}>{next.title} →</a>
          : <a href={href({ page: 'mastery' })}>精通标准 →</a>}
      </nav>
    </article>
  );
}

export function Mastery() {
  const { done } = useProgress();
  const r = ratio(done, masteryCriteria.map((m) => m.id));
  return (
    <article>
      <header className="stage-header">
        <h1>精通标准</h1>
        <p className="goal">全部做到，就说明你已经能独立设计并评审生产级 Agent。</p>
        <div className="overall">
          <ProgressBar value={r} label="精通标准进度" />
          <span>{Math.round(r * 100)}%</span>
        </div>
      </header>
      <section className="card">
        <ul className="tasks">
          {masteryCriteria.map((t) => <TaskItem key={t.id} task={t} />)}
        </ul>
      </section>
    </article>
  );
}
