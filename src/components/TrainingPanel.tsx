import type { Stage } from '../data/roadmap';
import { trainingExamples } from '../data/trainingExamples';
import { progress, useProgress } from '../progress';
import { CodeBlock, TaskItem } from './ui';

export function TrainingPanel({ stage }: { stage: Stage }) {
  const { notes } = useProgress();
  const course = stage.training;
  const evidenceKey = `evidence:${stage.id}`;

  return (
    <div className="training">
      <section className="card deliverable">
        <h2>本阶段训练目标</h2>
        <p>{course.outcome}</p>
        <p className="muted">前置条件：{course.prerequisites}</p>
        <nav className="actions" aria-label="本阶段内容">
          {[
            ['course', '站内课程'],
            ['lab', '动手实验'],
            ['incidents', '故障训练'],
            ['acceptance', '验收与证据'],
          ].map(([id, label]) => (
            <button type="button" key={id} onClick={() => document.getElementById(id)?.scrollIntoView({ block: 'start' })}>
              {label}
            </button>
          ))}
        </nav>
      </section>

      <section id="course">
        <h2>站内课程</h2>
        {course.lessons.map((lesson, i) => (
          <section className="card lesson" key={lesson.title}>
            <span className="badge">课程 {stage.index}.{i + 1}</span>
            <h3>{lesson.title}</h3>
            {lesson.explanation.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            <p className="worked-example"><strong>贯穿案例：</strong>{lesson.example}</p>
            <details className="self-check">
              <summary>自测：{lesson.question}</summary>
              <p>{lesson.answer}</p>
            </details>
          </section>
        ))}
      </section>

      <section id="lab" className="card">
        <h2>{course.lab.title}</h2>
        <p className="muted">{course.lab.setup}</p>
        <ol className="lab-steps">
          {course.lab.steps.map((step) => (
            <li key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.action}</p>
              <p className="expected"><strong>预期结果：</strong>{step.expected}</p>
            </li>
          ))}
        </ol>
        <h3>需要提交</h3>
        <ul>{course.lab.submission.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>

      <CodeBlock snippet={trainingExamples[stage.id]} />

      <section id="incidents">
        <h2>故障训练</h2>
        <p className="muted">在本地或专用测试环境复现，先提出假设，再按证据定位；不要在真实企业系统注入故障。</p>
        {course.incidents.map((incident) => (
          <details className="card incident" key={incident.symptom}>
            <summary>{incident.symptom}</summary>
            <dl>
              <dt>定位证据</dt><dd>{incident.diagnosis}</dd>
              <dt>修复方向</dt><dd>{incident.remedy}</dd>
              <dt>回归验证</dt><dd>{incident.verification}</dd>
            </dl>
          </details>
        ))}
      </section>

      <section id="acceptance" className="card deliverable">
        <h2>验收与证据</h2>
        <p className="muted">请实际完成测试、记录产物后再勾选。这些是自评记录，网站不运行或审核你的项目，也不会据此认证生产能力。</p>
        <ul className="tasks">
          {course.acceptance.map((task) => <TaskItem key={task.id} task={task} />)}
        </ul>
        <label className="evidence-label" htmlFor={evidenceKey}>实训证据与复盘</label>
        <p className="muted">记录仓库/提交、运行命令、数据与模型版本、逐项结果和残余问题。只在本浏览器保存并随进度备份；不要填写密钥、企业正文或个人信息。</p>
        <textarea
          id={evidenceKey}
          rows={7}
          placeholder={'产物/提交：\n验证命令与环境：\n数据、模型和提示词版本：\n验收结果（通过数/总数）：\n故障证据与修复：\n未解决问题：'}
          value={notes[evidenceKey] ?? ''}
          onChange={(event) => progress.setNote(evidenceKey, event.target.value)}
        />
      </section>
    </div>
  );
}
