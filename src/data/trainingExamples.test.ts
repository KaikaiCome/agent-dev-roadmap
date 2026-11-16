/// <reference types="node" />
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trainingExamples } from './trainingExamples';

describe('runnable training examples', () => {
  it('runs the offline model fixture and its tests without an API key', () => {
    const output = execFileSync(process.execPath, ['--test-reporter=tap', '--input-type=module'], {
      input: trainingExamples.intuition.code,
      encoding: 'utf8',
      env: { ...process.env, OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '' },
    });
    expect(output).toContain('# pass 2');
    expect(output).toContain('# fail 0');
  });

  it.each([
    { name: '27/30 with all critical checks passing', failed: [27, 28, 29], exit: 0 },
    { name: '26/30 even with critical checks passing', failed: [26, 27, 28, 29], exit: 1 },
    { name: '29/30 with a critical failure', failed: [0], exit: 1 },
  ])('enforces the gate for $name', ({ failed, exit }) => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-training-gate-'));
    try {
      const results = Array.from({ length: 30 }, (_, index) => ({
        id: `case-${index}`, critical: index < 10, passed: !failed.includes(index),
      }));
      const path = join(directory, 'results.json');
      writeFileSync(path, JSON.stringify(results));
      const result = spawnSync(process.execPath, ['--input-type=module', '-', path], {
        input: trainingExamples['eval-observability'].code,
        encoding: 'utf8',
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(exit);
      expect(JSON.parse(result.stdout).allowed).toBe(exit === 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects incomplete or duplicate evaluation results rather than reporting success', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-training-invalid-'));
    try {
      const path = join(directory, 'results.json');
      for (const rows of [
        [],
        Array.from({ length: 30 }, () => ({ id: 'duplicate', critical: true, passed: true })),
      ]) {
        writeFileSync(path, JSON.stringify(rows));
        const result = spawnSync(process.execPath, ['--input-type=module', '-', path], {
          input: trainingExamples['eval-observability'].code,
          encoding: 'utf8',
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Error:');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
