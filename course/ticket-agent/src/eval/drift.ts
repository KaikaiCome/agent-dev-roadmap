import { readFileSync } from 'node:fs';
import type { CaseTrials } from './passk.ts';

// 第 24 章：模型漂移检测。同样的用例、同样的代码，换了模型版本（或者服务商在同一个名字下悄悄换了模型），
// 结果就可能变。做法：每次 pass^k 评测都存一份快照（模型 id、日期、每条用例 n 次里过了几次），
// 新结果和基线快照逐条比较，用 Fisher 精确检验区分“真的变了”和“抽样噪声”。

export interface Snapshot {
  model: string;
  date: string;
  k: number;
  seed?: number;
  cases: Array<{ id: string; critical: boolean; n: number; passes: number }>;
}

export function toSnapshot(results: CaseTrials[], meta: { model: string; date?: string; seed?: number }): Snapshot {
  return {
    model: meta.model,
    date: meta.date ?? new Date().toISOString().slice(0, 10),
    k: results[0]?.n ?? 0,
    ...(meta.seed !== undefined ? { seed: meta.seed } : {}),
    cases: results.map(({ id, critical, n, passes }) => ({ id, critical, n, passes })),
  };
}

export function loadSnapshot(path: string): Snapshot {
  return JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
}

/**
 * 模型 id 是否固定到了快照。deepseek-chat、gpt-4o 这类别名会被服务商指向新版本，
 * 评测结果因此在“什么都没改”的情况下变化。带日期（gpt-4o-2024-08-06、claude-…-20241022）
 * 或显式版本号（本项目的 mock-stochastic-v1）的 id 才算固定。
 */
export function isPinnedModel(model: string): boolean {
  return /(\d{4}-\d{2}-\d{2}|\d{8}|-\d{4}|-v\d+(\.\d+)*)$/.test(model);
}

export interface CaseDrift {
  id: string;
  critical: boolean;
  before: number;
  after: number;
  pValue: number;
  change: 'regressed' | 'improved' | 'unchanged';
}

export interface DriftReport {
  cases: CaseDrift[];
  overall: { before: number; after: number; pValue: number };
  /** critical 用例在基线里 k 次全过，现在不是了。不等显著性，直接告警 */
  criticalBroken: string[];
  warnings: string[];
  drifted: boolean;
}

export function compareSnapshots(base: Snapshot, current: Snapshot, alpha = 0.05): DriftReport {
  const warnings: string[] = [];
  if (base.model !== current.model) warnings.push(`模型不同：基线 ${base.model}，当前 ${current.model}`);
  for (const model of new Set([base.model, current.model])) {
    if (!isPinnedModel(model)) warnings.push(`${model} 不是固定快照，服务商升级时结果会悄悄变化`);
  }
  const baseById = new Map(base.cases.map((c) => [c.id, c]));
  const cases: CaseDrift[] = [];
  for (const now of current.cases) {
    const was = baseById.get(now.id);
    if (!was) {
      warnings.push(`用例 ${now.id} 在基线里不存在`);
      continue;
    }
    const pValue = fisherExact(was.passes, was.n - was.passes, now.passes, now.n - now.passes);
    const before = was.passes / was.n;
    const after = now.passes / now.n;
    cases.push({ id: now.id, critical: now.critical, before, after, pValue, change: pValue >= alpha ? 'unchanged' : after < before ? 'regressed' : 'improved' });
  }
  const sum = (s: Snapshot, field: 'n' | 'passes') => s.cases.reduce((total, c) => total + c[field], 0);
  const overall = {
    before: sum(base, 'passes') / sum(base, 'n'),
    after: sum(current, 'passes') / sum(current, 'n'),
    pValue: fisherExact(sum(base, 'passes'), sum(base, 'n') - sum(base, 'passes'), sum(current, 'passes'), sum(current, 'n') - sum(current, 'passes')),
  };
  const criticalBroken = current.cases
    .filter((c) => c.critical && c.passes < c.n && baseById.get(c.id)?.passes === baseById.get(c.id)?.n)
    .map((c) => c.id);
  return {
    cases,
    overall,
    criticalBroken,
    warnings,
    drifted: criticalBroken.length > 0 || cases.some((c) => c.change !== 'unchanged') || overall.pValue < alpha,
  };
}

/** 2×2 列联表 [[a, b], [c, d]] 的双侧 Fisher 精确检验 */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const row1 = a + b;
  const col1 = a + c;
  const n = a + b + c + d;
  const logFact = (x: number) => { let s = 0; for (let i = 2; i <= x; i++) s += Math.log(i); return s; };
  const prob = (x: number) => Math.exp(logFact(row1) + logFact(n - row1) + logFact(col1) + logFact(n - col1)
    - logFact(n) - logFact(x) - logFact(row1 - x) - logFact(col1 - x) - logFact(n - row1 - col1 + x));
  const observed = prob(a);
  let p = 0;
  for (let x = Math.max(0, row1 + col1 - n); x <= Math.min(row1, col1); x++) {
    const px = prob(x);
    if (px <= observed * (1 + 1e-7)) p += px;
  }
  return Math.min(1, p);
}
