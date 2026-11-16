import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { stages } from './data/roadmap';
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

describe('App', () => {
  it('shows all stages on the home page', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: /从 React 开发到企业级 Agent 交付/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /开始第一个实验/ }).getAttribute('href')).toBe('#/stage/intuition');
    expect(screen.getAllByText('从零手写一个 Agent').length).toBeGreaterThan(0);
  });

  it('checks a task, persists it, and updates stage progress', async () => {
    render(<App />);
    go('#/stage/from-scratch');
    const box = screen.getByRole('checkbox', { name: /限制最大步数/ });
    await userEvent.click(box);

    expect((box as HTMLInputElement).checked).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).done['s1-max-steps']).toBe(true);
    const bar = screen.getAllByRole('progressbar', { name: '从零手写一个 Agent 进度' })[0];
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  });

  it('shows the code skeleton on stage 1 and saves notes', async () => {
    render(<App />);
    go('#/stage/from-scratch');
    await userEvent.click(screen.getByText('拓展代码骨架（非企业项目完整实现）'));
    expect(screen.getByText(/最小 coding agent/)).toBeTruthy();

    await userEvent.type(screen.getByLabelText('学习笔记'), 'abc');
    expect(progress.get().notes['from-scratch']).toBe('abc');
  });

  it('shows a not-found page for an unknown stage', () => {
    render(<App />);
    go('#/stage/nope');
    expect(screen.getByText('未找到该页面')).toBeTruthy();
  });

  it.each(stages)('provides a complete training flow for $id', (stage) => {
    render(<App />);
    go(`#/stage/${stage.id}`);
    expect(screen.getByRole('heading', { name: '站内课程' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: stage.training.lab.title })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '故障训练' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '验收与证据' })).toBeTruthy();
    expect(screen.getByLabelText('实训证据与复盘')).toBeTruthy();
    for (const task of stage.training.acceptance) {
      expect(screen.getByRole('checkbox', { name: task.text })).toBeTruthy();
    }
  });

  it('keeps new acceptance and evidence separate from old progress and stage notes', async () => {
    progress.toggle('s1-max-steps');
    progress.setNote('from-scratch', 'existing note');
    render(<App />);
    go('#/stage/from-scratch');
    const gate = stages[1].training.acceptance[0];
    expect((screen.getByRole('checkbox', { name: gate.text }) as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole('checkbox', { name: gate.text }));
    await userEvent.type(screen.getByLabelText('实训证据与复盘'), 'commit abc; tests passed');

    go('#/stage/agent-ui');
    expect((screen.getByLabelText('实训证据与复盘') as HTMLTextAreaElement).value).toBe('');
    go('#/stage/from-scratch');
    expect((screen.getByLabelText('实训证据与复盘') as HTMLTextAreaElement).value).toBe('commit abc; tests passed');
    expect((screen.getByLabelText('学习笔记') as HTMLTextAreaElement).value).toBe('existing note');
    expect((screen.getByRole('checkbox', { name: /限制最大步数/ }) as HTMLInputElement).checked).toBe(true);

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(saved.notes['evidence:from-scratch']).toBe('commit abc; tests passed');
    go('#/mastery');
    expect(screen.getByText('1 / 2 项自评验收')).toBeTruthy();
  });

  it('scrolls within a training stage without changing the hash route', async () => {
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      render(<App />);
      go('#/stage/intuition');
      await userEvent.click(screen.getByRole('button', { name: '动手实验' }));
      expect(scroll).toHaveBeenCalledWith({ block: 'start' });
      expect(window.location.hash).toBe('#/stage/intuition');
      await userEvent.click(screen.getByText(/^自测：用户说/));
      expect(screen.getByText(/不可以。租户来自已认证服务端会话/)).toBeTruthy();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
