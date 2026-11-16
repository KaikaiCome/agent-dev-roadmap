import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from './App';
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
    expect(screen.getByRole('heading', { level: 1, name: /Agent 精通路线/ })).toBeTruthy();
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
    expect(screen.getByText(/最小 coding agent/)).toBeTruthy();

    await userEvent.type(screen.getByLabelText('学习笔记'), 'abc');
    expect(progress.get().notes['from-scratch']).toBe('abc');
  });

  it('shows a not-found page for an unknown stage', () => {
    render(<App />);
    go('#/stage/nope');
    expect(screen.getByText('未找到该阶段')).toBeTruthy();
  });
});
