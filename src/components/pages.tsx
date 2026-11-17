import { useRef } from 'react';
import { allTaskIds, masteryCriteria, pillars, stages, stageTaskIds, type Stage } from '../data/roadmap';
import { snippets } from '../data/snippets';
import { capstone } from '../data/training';
import { chapters, tutorialIntro } from '../data/tutorial';
import { parseProgress, progress, ratio, useProgress } from '../progress';
import { href } from '../router';
import { CodeBlock, ProgressBar, TaskItem } from './ui';
import { TrainingPanel } from './TrainingPanel';

export function Home() {
  const { done } = useProgress();
  const overall = ratio(done, allTaskIds);
  return (
    <>
      <header className="hero">
        <span className="badge">面向前端开发者的企业级 Agent 实训</span>
        <h1>从 React 开发到企业级 Agent 交付</h1>
        <p>不止列学习清单：跟着 12 章基础篇实战教程，从一行模型调用写到带检索、审批、多租户、审计、评估和部署的企业级 Agent；再用高级篇深入 MCP、上下文工程、评审校准、性能可靠性、面试、生产难点的研究路径，以及混合检索等难点的落地实现。每一步都有可运行的源码、命令和真实输出。</p>
        <div className="overall">
          <ProgressBar value={overall} label="总进度" />
          <span>总进度 {Math.round(overall * 100)}%</span>
        </div>
        <a className="start-link" href={href({ page: 'learn', id: chapters[0].id })}>从第 0 章开始动手 →</a>
        <p className="muted">总进度包含教程练习、专题任务与实训验收，是自评记录，不是能力认证。</p>
      </header>

      <section className="card deliverable">
        <h2>实战教程：从 0 搭建企业级 Agent</h2>
        <p>{tutorialIntro.lead}</p>
        <ol className="learning-flow">
          {chapters.map((c) => (
            <li key={c.id}><a href={href({ page: 'learn', id: c.id })}>{c.title}</a> — {c.summary}</li>
          ))}
        </ol>
      </section>

      <section className="card deliverable">
        <h2>贯穿项目：{capstone.title}</h2>
        <p>{capstone.brief}</p>
        <p className="architecture">{capstone.architecture}</p>
        <ol className="learning-flow">
          {capstone.workflow.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <a className="start-link" href={href({ page: 'stage', id: stages[0].id })}>深入专题：开始第一个实验 →</a>
      </section>

      <section className="card">
        <h2>开始前的准备</h2>
        <ul className="preparation">
          {capstone.preparation.map((item) => <li key={item}>{item}</li>)}
        </ul>
        <p className="muted">{capstone.boundary}</p>
      </section>

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
        <h2>深入专题（原理与企业场景）</h2>
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
                  <p className="muted">{s.training.lessons.length} 节站内课程 · {s.training.lab.steps.length} 步实验 · {s.training.incidents.length} 个故障案例</p>
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

      <TrainingPanel stage={stage} />

      <section>
        <h2>基础与拓展任务</h2>
        <p className="muted">保留原路线的学习清单与已存进度。Coding Agent、开源贡献和框架对比可用于拓展，不替代上面的企业项目验收。</p>
      </section>
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

      {snippet && (
        <details className="reference-code">
          <summary>拓展代码骨架（非企业项目完整实现）</summary>
          <CodeBlock snippet={snippet} />
        </details>
      )}

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
        <p className="goal">以可复现项目与测试证据检查能力，而不是以勾选代替交付。实际生产接入仍需业务、安全与运维审查。</p>
        <div className="overall">
          <ProgressBar value={r} label="精通标准进度" />
          <span>{Math.round(r * 100)}%</span>
        </div>
      </header>
      <section className="card">
        <h2>七阶段交付检查</h2>
        <p className="muted">逐阶段核对验收项及实训证据；已有的基础任务完成记录不会自动视为实训通过。</p>
        <ul className="delivery-list">
          {stages.map((stage) => {
            const gates = stage.training.acceptance;
            return (
              <li key={stage.id}>
                <a href={href({ page: 'stage', id: stage.id })}>{stage.index}. {stage.title}</a>
                <span>{gates.filter((gate) => done[gate.id]).length} / {gates.length} 项自评验收</span>
                <p>{stage.training.outcome}</p>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="card">
        <ul className="tasks">
          {masteryCriteria.map((t) => <TaskItem key={t.id} task={t} />)}
        </ul>
      </section>
    </article>
  );
}
