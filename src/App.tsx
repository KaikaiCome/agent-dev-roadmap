import { useEffect } from 'react';
import { Home, Mastery, StageView } from './components/pages';
import { ProgressBar } from './components/ui';
import { masteryCriteria, stages, stageTaskIds } from './data/roadmap';
import { ratio, useProgress } from './progress';
import { href, parseRoute, useHash } from './router';

export default function App() {
  const route = parseRoute(useHash());
  const { done } = useProgress();
  const stage = route.page === 'stage' ? stages.find((s) => s.id === route.id) : undefined;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.page, stage?.id]);

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="阶段导航">
        <a className="brand" href={href({ page: 'home' })}>Agent 精通路线</a>
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
        {route.page === 'home' && <Home />}
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <article>
      <h1>未找到该阶段</h1>
      <a href={href({ page: 'home' })}>返回首页</a>
    </article>
  );
}
