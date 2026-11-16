import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from './App';
import { courseFiles } from './data/courseFiles';
import { allTaskIds, stages } from './data/roadmap';
import { chapters, tutorialTaskIds } from './data/tutorial';
import { progress, STORAGE_KEY } from './progress';

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

beforeEach(() => {
  window.scrollTo = () => {};
  progress.reset();
  go('#/');
});
afterEach(cleanup);

describe('tutorial data', () => {
  it('only references source files that exist in the reference project', () => {
    const referenced = chapters.flatMap((c) => c.steps.flatMap((s) => s.files ?? []));
    expect(referenced).toContain('Dockerfile');
    expect(referenced).toContain('.env.example');
    for (const path of referenced) expect(courseFiles[path], path).toBeTypeOf('string');
  });

  it('uses unique chapter ids, unique task ids and valid deeper links', () => {
    expect(new Set(chapters.map((c) => c.id)).size).toBe(chapters.length);
    expect(new Set(allTaskIds).size).toBe(allTaskIds.length);
    for (const id of tutorialTaskIds) expect(allTaskIds).toContain(id);
    for (const c of chapters) {
      if (c.deeper) expect(stages.map((s) => s.id)).toContain(c.deeper.stageId);
    }
  });
});

describe('tutorial pages', () => {
  it('starts from the home page call to action', () => {
    render(<App />);
    const start = screen.getByRole('link', { name: /从第 0 章开始动手/ });
    expect(start.getAttribute('href')).toBe('#/learn/setup');
    go('#/learn');
    expect(screen.getAllByRole('heading', { name: chapters[0].title }).length).toBeGreaterThan(0);
  });

  it.each(chapters)('renders chapter $id with steps, pitfalls, exercises and pager', (chapter) => {
    render(<App />);
    go(`#/learn/${chapter.id}`);
    expect(screen.getByRole('heading', { level: 1, name: chapter.title })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '动手步骤' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '常见问题排查' })).toBeTruthy();
    expect(screen.queryByText(/缺少文件/)).toBeNull();
    for (const task of chapter.exercises) {
      expect(screen.getByRole('checkbox', { name: new RegExp(escape(task.text.slice(0, 12))) })).toBeTruthy();
    }
  });

  it('persists a checked exercise and chapter notes', async () => {
    const [chapter] = chapters;
    const task = chapter.exercises[0];
    render(<App />);
    go(`#/learn/${chapter.id}`);
    await userEvent.click(screen.getByRole('checkbox', { name: new RegExp(escape(task.text.slice(0, 12))) }));
    await userEvent.type(screen.getByLabelText('本章笔记'), 'ok');
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(saved.done[task.id]).toBe(true);
    expect(saved.notes[`learn:${chapter.id}`]).toBe('ok');
  });

  it('shows a not-found page for an unknown chapter', () => {
    render(<App />);
    go('#/learn/nope');
    expect(screen.getByText('未找到该页面')).toBeTruthy();
  });

  it('groups chapters into basic and advanced parts, and shows interview questions', () => {
    render(<App />);
    go('#/learn');
    const advanced = screen.getByRole('heading', { name: /高级篇/ }).closest('section')!;
    const advancedLinks = Array.from(advanced.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(advancedLinks).toEqual(chapters.filter((c) => c.part === 'advanced').map((c) => `#/learn/${c.id}`));
    expect(advancedLinks).not.toContain('#/learn/setup');

    const chapter = chapters.find((c) => c.interview?.length)!;
    go(`#/learn/${chapter.id}`);
    expect(screen.getByRole('heading', { name: '面试追问' })).toBeTruthy();
    expect(screen.getByText(chapter.interview![0].q)).toBeTruthy();
  });
});

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
