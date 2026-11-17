import type { ChatModel } from '../llm/types.ts';
import type { EvalCase } from '../eval/cases.ts';
import { gate, runCase, type CaseResult, type GateReport } from '../eval/evaluate.ts';
import type { SearchFn } from '../tools/knowledge.ts';

// 第 25 章：前后对比评测。同一套用例分别跑基线模型 A 和候选模型 B，逐条比较，而不是只比总通过率：
// 总分上升的同时，可能有关键用例从通过变成失败——这正是换模型最常见的事故。

export type Change = 'both_pass' | 'both_fail' | 'fixed' | 'regressed';

export interface CaseDiff {
  id: string;
  critical: boolean;
  change: Change;
  a: CaseResult;
  b: CaseResult;
}

export interface Comparison {
  diffs: CaseDiff[];
  a: GateReport;
  b: GateReport;
  fixed: string[];
  regressed: string[];
  criticalRegressions: string[];
  /** McNemar 精确检验的双侧 p 值：只看结果不一致的用例，问“改进和退化的差距是否可能只是运气” */
  pValue: number;
  verdict: 'block' | 'review' | 'better' | 'inconclusive';
}

export async function compareModels(cases: EvalCase[], a: ChatModel, b: ChatModel, search?: SearchFn): Promise<Comparison> {
  const diffs: CaseDiff[] = [];
  for (const testCase of cases) {
    const resultA = await runCase(testCase, a, search);
    const resultB = await runCase(testCase, b, search);
    diffs.push({ id: testCase.id, critical: testCase.critical ?? false, change: classify(resultA.passed, resultB.passed), a: resultA, b: resultB });
  }
  return summarize(diffs);
}

export function summarize(diffs: CaseDiff[]): Comparison {
  const fixed = diffs.filter((d) => d.change === 'fixed').map((d) => d.id);
  const regressed = diffs.filter((d) => d.change === 'regressed').map((d) => d.id);
  const criticalRegressions = diffs.filter((d) => d.change === 'regressed' && d.critical).map((d) => d.id);
  const a = gate(diffs.map((d) => d.a));
  const b = gate(diffs.map((d) => d.b));
  const pValue = mcnemarExact(fixed.length, regressed.length);
  const verdict = criticalRegressions.length > 0 || !b.passed
    ? 'block'
    : regressed.length > 0
      ? 'review'
      : fixed.length > 0 && pValue < 0.05 ? 'better' : 'inconclusive';
  return { diffs, a, b, fixed, regressed, criticalRegressions, pValue, verdict };
}

function classify(passedA: boolean, passedB: boolean): Change {
  if (passedA && passedB) return 'both_pass';
  if (!passedA && !passedB) return 'both_fail';
  return passedB ? 'fixed' : 'regressed';
}

/**
 * McNemar 精确检验：在“两个模型其实一样好”的假设下，不一致的 n = fixed + regressed 条用例
 * 各有一半概率偏向任一方，p = 2 × P(X ≤ min(fixed, regressed))，X ~ Binomial(n, 0.5)。
 * 不一致的用例少于 6 条时，即使全部偏向一方，p 也不会低于 0.05。
 */
export function mcnemarExact(fixed: number, regressed: number): number {
  const n = fixed + regressed;
  if (n === 0) return 1;
  const k = Math.min(fixed, regressed);
  let tail = 0;
  let coefficient = 1;
  for (let i = 0; i <= k; i++) {
    if (i > 0) coefficient = (coefficient * (n - i + 1)) / i;
    tail += coefficient;
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}
