import { useSyncExternalStore } from 'react';

export interface ProgressState {
  done: Record<string, true>;
  notes: Record<string, string>;
}

export const STORAGE_KEY = 'agent-dev-roadmap:v1';

const empty: ProgressState = { done: {}, notes: {} };

/** Parses persisted or imported JSON; returns null for anything that is not a progress object. */
export function parseProgress(raw: string | null): ProgressState | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { done, notes } = value as Partial<Record<keyof ProgressState, unknown>>;
  const result: ProgressState = { done: {}, notes: {} };
  if (typeof done === 'object' && done !== null) {
    for (const [k, v] of Object.entries(done)) if (v === true) result.done[k] = true;
  }
  if (typeof notes === 'object' && notes !== null) {
    for (const [k, v] of Object.entries(notes)) if (typeof v === 'string') result.notes[k] = v;
  }
  return result;
}

let state: ProgressState = parseProgress(localStorage.getItem(STORAGE_KEY)) ?? empty;
const listeners = new Set<() => void>();

function commit(next: ProgressState) {
  state = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  listeners.forEach((l) => l());
}

export const progress = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  toggle(id: string) {
    const done = { ...state.done };
    if (done[id]) delete done[id];
    else done[id] = true;
    commit({ ...state, done });
  },
  setNote(stageId: string, text: string) {
    commit({ ...state, notes: { ...state.notes, [stageId]: text } });
  },
  replace(next: ProgressState) {
    commit(next);
  },
  reset() {
    commit(empty);
  },
};

if (typeof window !== 'undefined') {
  // Keep multiple open tabs in sync.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    state = parseProgress(e.newValue) ?? empty;
    listeners.forEach((l) => l());
  });
}

export function useProgress(): ProgressState {
  return useSyncExternalStore(progress.subscribe, progress.get);
}

export function ratio(done: ProgressState['done'], ids: string[]): number {
  if (ids.length === 0) return 0;
  return ids.filter((id) => done[id]).length / ids.length;
}
