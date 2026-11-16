import { useState } from 'react';
import { COURSE_REPO_URL, courseFiles } from '../data/courseFiles';
import { stages } from '../data/roadmap';
import { chapterIndex, chapters, tutorialIntro, type Chapter, type TutorialStep } from '../data/tutorial';
import { progress, ratio, useProgress } from '../progress';
import { href } from '../router';
import { ProgressBar, TaskItem } from './ui';

/** 把 `code` 片段渲染为行内代码，其余按纯文本输出 */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 1
          ? <code key={i}>{part.slice(1, -1)}</code>
          : <span key={i}>{part}</span>,
      )}
    </>
  );
}

function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? '已复制' : label}
    </button>
  );
}

function SourceFile({ path }: { path: string }) {
  const source = courseFiles[path];
  if (source === undefined) return <p className="error">缺少文件：{path}</p>;
  const lines = source.split('\n').length;
  return (
    <details className="source-file">
      <summary>
        <span className="file-path">{path}</span>
        <span className="muted">{lines} 行 · 点击展开</span>
      </summary>
      <div className="code-toolbar">
        <a href={`${COURSE_REPO_URL}/${path}`} target="_blank" rel="noreferrer">在 GitHub 查看</a>
        <CopyButton text={source} label="复制文件" />
      </div>
      <pre className="code"><code>{source}</code></pre>
    </details>
  );
}

function Terminal({ title, text, copy }: { title: string; text: string; copy?: boolean }) {
  return (
    <div className="terminal">
      <div className="code-toolbar">
        <span>{title}</span>
        {copy && <CopyButton text={text} />}
      </div>
      <pre className="code"><code>{text}</code></pre>
    </div>
  );
}

function Step({ step, index }: { step: TutorialStep; index: number }) {
  return (
    <li className="tutorial-step">
      <h3><span className="step-index">{index + 1}</span>{step.title}</h3>
      {step.text.map((paragraph) => <p key={paragraph}><RichText text={paragraph} /></p>)}
      {step.code && <Terminal title={step.code.title} text={step.code.content} />}
      {step.files?.map((path) => <SourceFile key={path} path={path} />)}
      {step.command && <Terminal title="运行命令" text={step.command} copy />}
      {step.output && (
        <>
          <Terminal title={step.outputNote ? '示例输出' : '实际输出'} text={step.output} />
          {step.outputNote && <p className="muted output-note">{step.outputNote}</p>}
        </>
      )}
    </li>
  );
}

export function TutorialHome() {
  return (
    <article>
      <header className="stage-header">
        <span className="badge">实战教程 · 零基础可学</span>
        <h1>{tutorialIntro.title}</h1>
        <p className="goal">{tutorialIntro.lead}</p>
      </header>

      <section className="card deliverable">
        <h2>你将亲手做出</h2>
        <ul>{tutorialIntro.project.map((item) => <li key={item}>{item}</li>)}</ul>
        <p className="muted">{tutorialIntro.stack}</p>
      </section>

      <section className="card">
        <h2>怎么学</h2>
        <ul>{tutorialIntro.howToStudy.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>

      <section>
        <h2>基础篇：从零搭建企业级 Agent</h2>
        <ChapterList list={chapters.filter((c) => (c.part ?? 'basic') === 'basic')} />
      </section>

      <section>
        <h2>高级篇：资深工程师的深水区</h2>
        <p className="muted">{tutorialIntro.advanced}</p>
        <ChapterList list={chapters.filter((c) => c.part === 'advanced')} />
      </section>
    </article>
  );
}

function ChapterList({ list }: { list: Chapter[] }) {
  const { done } = useProgress();
  return (
    <ol className="stage-list">
      {list.map((chapter) => (
        <li key={chapter.id}>
          <a className="card stage-card" href={href({ page: 'learn', id: chapter.id })}>
            <div className="stage-card-head">
              <span className="badge">约 {chapter.minutes} 分钟</span>
            </div>
            <h3>{chapter.title}</h3>
            <p>{chapter.summary}</p>
            <ProgressBar value={ratio(done, chapter.exercises.map((t) => t.id))} label={`${chapter.title} 练习进度`} />
          </a>
        </li>
      ))}
    </ol>
  );
}

export function ChapterView({ chapter }: { chapter: Chapter }) {
  const { done, notes } = useProgress();
  const index = chapterIndex(chapter.id);
  const prev = chapters[index - 1];
  const next = chapters[index + 1];
  const ids = chapter.exercises.map((t) => t.id);
  const deeper = chapter.deeper ? stages.find((s) => s.id === chapter.deeper!.stageId) : undefined;
  const noteKey = `learn:${chapter.id}`;

  return (
    <article>
      <header className="stage-header">
        <span className="badge">{chapter.part === 'advanced' ? '高级篇' : '实战教程'} · 约 {chapter.minutes} 分钟</span>
        <h1>{chapter.title}</h1>
        <p className="goal">{chapter.summary}</p>
        <p><strong>学完你会得到：</strong>{chapter.outcome}</p>
      </header>

      <section className="card">
        <h2>先弄懂这些概念</h2>
        <dl className="concepts">
          {chapter.concepts.map((c) => (
            <div key={c.term}>
              <dt>{c.term}</dt>
              <dd>{c.text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <h2>动手步骤</h2>
        <ol className="tutorial-steps">
          {chapter.steps.map((step, i) => <Step key={step.title} step={step} index={i} />)}
        </ol>
      </section>

      <section className="card">
        <h2>常见问题排查</h2>
        <div className="pitfalls">
          {chapter.pitfalls.map((p) => (
            <div className="pitfall" key={p.symptom}>
              <p><strong>现象：</strong>{p.symptom}</p>
              <p><strong>原因：</strong>{p.cause}</p>
              <p><strong>解决：</strong>{p.fix}</p>
            </div>
          ))}
        </div>
      </section>

      {chapter.interview && (
        <section className="card">
          <h2>面试追问</h2>
          <p className="muted">先自己回答，再展开对照要点。要点不是标准答案，面试官更看重你能否结合做过的项目讲清取舍。</p>
          <div className="interview">
            {chapter.interview.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <ul>{item.a.map((point) => <li key={point}><RichText text={point} /></li>)}</ul>
              </details>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h2>练习（完成后打勾）</h2>
        <div className="overall">
          <ProgressBar value={ratio(done, ids)} label={`${chapter.title} 练习进度`} />
          <span>{ids.filter((id) => done[id]).length} / {ids.length}</span>
        </div>
        <ul className="tasks">
          {chapter.exercises.map((task) => <TaskItem key={task.id} task={task} />)}
        </ul>
        <label className="sr-label" htmlFor={noteKey}>本章笔记</label>
        <textarea
          id={noteKey}
          rows={4}
          placeholder="记录你的改动、遇到的问题和解决方法……"
          value={notes[noteKey] ?? ''}
          onChange={(e) => progress.setNote(noteKey, e.target.value)}
        />
      </section>

      {deeper && (
        <p className="muted">
          想了解更多原理和企业场景？<a href={href({ page: 'stage', id: deeper.id })}>{chapter.deeper!.text} →</a>
        </p>
      )}

      <nav className="pager">
        {prev ? <a href={href({ page: 'learn', id: prev.id })}>← {prev.title}</a> : <a href={href({ page: 'learn' })}>← 教程目录</a>}
        {next ? <a href={href({ page: 'learn', id: next.id })}>{next.title} →</a> : <a href={href({ page: 'mastery' })}>精通标准 →</a>}
      </nav>
    </article>
  );
}
