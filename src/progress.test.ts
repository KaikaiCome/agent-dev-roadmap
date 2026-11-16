import { describe, expect, it } from 'vitest';
import { allTaskIds } from './data/roadmap';
import { parseProgress } from './progress';

describe('parseProgress', () => {
  it('keeps only true flags and string notes', () => {
    const parsed = parseProgress(JSON.stringify({
      done: { a: true, b: false, c: 'yes' },
      notes: { s1: 'hello', s2: 3 },
    }));
    expect(parsed).toEqual({ done: { a: true }, notes: { s1: 'hello' } });
  });

  it('rejects invalid input', () => {
    expect(parseProgress(null)).toBeNull();
    expect(parseProgress('not json')).toBeNull();
    expect(parseProgress('42')).toBeNull();
  });
});

describe('roadmap data', () => {
  it('uses unique task ids so persisted progress maps to one task', () => {
    expect(new Set(allTaskIds).size).toBe(allTaskIds.length);
  });
});
