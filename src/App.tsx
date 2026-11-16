import { useEffect } from 'react';
import { Home, Mastery, StageView } from './components/pages';
import { ChapterView, TutorialHome } from './components/Tutorial';
import { ProgressBar } from './components/ui';
import { masteryCriteria, stages, stageTaskIds } from './data/roadmap';
import { chapters } from './data/tutorial';
import { ratio, useProgress } from './progress';
import { href, parseRoute, useHash } from './router';

export default function App() {
  const route = parseRoute(useHash());
  const { done } = useProgress();
  const stage = route.page === 'stage' ? stages.find((s) => s.id === route.id) : undefined;
  const chapter = route.page === 'learn' && route.id ? chapters.find((c) => c.id === route.id) : undefined;
  const learnId = route.page === 'learn' ? route.id : undefined;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.page, stage?.id, learnId]);

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="阶段导航">
        <a className="brand" href={href({ page: 'home' })}>Agent 精通路线</a>
        <p className="nav-group">实战教程（从这里开始）</p>
        <ul>
          <li>
            <a href={href({ page: 'learn' })} aria-current={route.page === 'learn' && !route.id ? 'page' : undefined}>
              <span>教程目录</span>
            </a>
          </li>
          {chapters.filter((c) => c.part !== 'advanced').map((c) => (
            <li key={c.id}>
              <a href={href({ page: 'learn', id: c.id })} aria-current={chapter?.id === c.id ? 'page' : undefined}>
                <span>{c.title}</span>
                <ProgressBar value={ratio(done, c.exercises.map((t) => t.id))} label={`${c.title} 练习进度`} />
              </a>
            </li>
          ))}
        </ul>
        <p className="nav-group">实战教程 · 高级篇</p>
        <ul>
          {chapters.filter((c) => c.part === 'advanced').map((c) => (
            <li key={c.id}>
              <a href={href({ page: 'learn', id: c.id })} aria-current={chapter?.id === c.id ? 'page' : undefined}>
                <span>{c.title}</span>
                <ProgressBar value={ratio(done, c.exercises.map((t) => t.id))} label={`${c.title} 练习进度`} />
              </a>
            </li>
          ))}
        </ul>
        <p className="nav-group">深入专题</p>
        <ul>
          {stages.map((s) => (
            <li key={s.id}>
              <a
                href={href({ page: 'stage', id: s.id })}
                aria-current={stage?.id === s.id ? 'page' : undefined}
              >
                <span>{s.index}. {s.title}</span>
                <ProgressBar value={ratio(done, stageTaskIds(s))} label={`${s.title} 进度`} />
              </a>
            </li>
          ))}
          <li>
            <a href={href({ page: 'mastery' })} aria-current={route.page === 'mastery' ? 'page' : undefined}>
              <span>★ 精通标准</span>
              <ProgressBar value={ratio(done, masteryCriteria.map((m) => m.id))} label="精通标准进度" />
            </a>
          </li>
        </ul>
      </nav>
      <main className="content">
        {route.page === 'mastery' && <Mastery />}
        {route.page === 'stage' && (stage ? <StageView stage={stage} /> : <NotFound />)}
        {route.page === 'learn' && !route.id && <TutorialHome />}
        {route.page === 'learn' && route.id && (chapter ? <ChapterView chapter={chapter} /> : <NotFound />)}
        {route.page === 'home' && <Home />}
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <article>
      <h1>未找到该页面</h1>
      <a href={href({ page: 'home' })}>返回首页</a>
    </article>
  );
}
