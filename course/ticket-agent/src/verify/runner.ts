import { join } from 'node:path';
import { runProcess } from '../coding/sandbox.ts';

export interface Check {
  name: string;
  argv: string[];
  env?: Record<string, string>;
  /** 相对参考项目根目录，子项目的测试要在自己的目录里运行 */
  cwd?: string;
  /** 退出码为 0 之外，输出还必须匹配这个正则（输出过长时只保留开头和结尾，关键结论要打印在结尾） */
  expect?: RegExp;
  timeoutMs?: number;
  /** 返回字符串表示跳过及原因，例如可选子项目没有安装依赖 */
  skip?: () => string | undefined;
}

export interface ChapterChecks {
  id: string;
  title: string;
  checks: Check[];
}

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  chapter: string;
  name: string;
  status: CheckStatus;
  durationMs: number;
  reason?: string;
  output?: string;
}

export interface RunOptions {
  cwd: string;
  baseEnv: Record<string, string>;
  defaultTimeoutMs?: number;
  onResult?: (result: CheckResult) => void;
}

export function selectChapters(all: ChapterChecks[], ids: string[]): ChapterChecks[] {
  if (ids.length === 0) return all;
  const unknown = ids.filter((id) => !all.some((chapter) => chapter.id === id));
  if (unknown.length) throw new Error(`未知章节：${unknown.join(', ')}。可选：${all.map((c) => c.id).join(', ')}`);
  return all.filter((chapter) => ids.includes(chapter.id));
}

export async function runChecks(chapters: ChapterChecks[], options: RunOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  // 顺序执行：多个检查会写同一个 data 目录、起子进程，并行会互相干扰，失败也更难定位
  for (const chapter of chapters) {
    for (const check of chapter.checks) {
      const result = await runCheck(chapter.id, check, options);
      results.push(result);
      options.onResult?.(result);
    }
  }
  return results;
}

async function runCheck(chapter: string, check: Check, options: RunOptions): Promise<CheckResult> {
  const skipped = check.skip?.();
  if (skipped) return { chapter, name: check.name, status: 'skip', durationMs: 0, reason: skipped };
  const timeoutMs = check.timeoutMs ?? options.defaultTimeoutMs ?? 180_000;
  const run = await runProcess(check.argv, {
    cwd: check.cwd ? join(options.cwd, check.cwd) : options.cwd,
    env: { ...options.baseEnv, ...check.env },
    timeoutMs,
    maxOutputChars: 6_000,
  }).catch((error: Error) => ({ exitCode: null, timedOut: false, output: error.message, durationMs: 0 }));
  const base = { chapter, name: check.name, durationMs: run.durationMs, output: run.output };
  if (run.timedOut) return { ...base, status: 'fail', reason: `超时（${timeoutMs}ms）` };
  if (run.exitCode !== 0) return { ...base, status: 'fail', reason: `退出码 ${run.exitCode}` };
  if (check.expect && !check.expect.test(run.output)) return { ...base, status: 'fail', reason: `输出不包含 ${check.expect}` };
  return { chapter, name: check.name, status: 'pass', durationMs: run.durationMs };
}

export function summarize(results: CheckResult[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, skip: 0 };
  for (const result of results) counts[result.status] += 1;
  return counts;
}
