import type { ChatModel } from '../llm/types.ts';
import type { SearchFn } from '../tools/knowledge.ts';
import type { EvalCase } from './cases.ts';
import { runCase, type CaseResult } from './evaluate.ts';

// 第 24 章：同一条用例跑 n 次，用两个指标描述“模型靠不靠得住”：
//   pass@k：k 次里至少成功一次的概率（Chen et al. 2021，代码生成常用：可以多试几次挑一个对的）；
//   pass^k：k 次全部成功的概率（τ-bench, Yao et al. 2024：Agent 面对的是 k 个不同的用户，每个都要做对）。
// 两者都用 n 次试验里成功 c 次的无偏估计，k ≤ n。

/** 组合数 C(n, k)，用连乘避免大数 */
export function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

/** pass@k = 1 − C(n−c, k) / C(n, k) */
export function passAtK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`k=${k} 不能大于试验次数 n=${n}`);
  return 1 - comb(n - c, k) / comb(n, k);
}

/** pass^k = C(c, k) / C(n, k)：从 n 次里随机挑 k 次，全部成功的概率 */
export function passHatK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`k=${k} 不能大于试验次数 n=${n}`);
  return comb(c, k) / comb(n, k);
}

/** 二项比例的 Wilson 置信区间（默认 95%）。比“p ± 1.96·√(p(1−p)/n)”在 n 小、p 接近 0 或 1 时可靠得多 */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export interface CaseTrials {
  id: string;
  critical: boolean;
  n: number;
  passes: number;
  /** 失败原因 → 出现次数。同一用例的失败原因不同，往往说明是不稳定而不是确定的 bug */
  failures: Record<string, number>;
  trials: CaseResult[];
}

export async function runTrials(cases: EvalCase[], model: ChatModel, k: number, search?: SearchFn, onTrial?: (result: CaseResult, trial: number) => void): Promise<CaseTrials[]> {
  const all: CaseTrials[] = [];
  for (const testCase of cases) {
    const trials: CaseResult[] = [];
    for (let trial = 1; trial <= k; trial++) {
      const result = await runCase(testCase, model, search);
      trials.push(result);
      onTrial?.(result, trial);
    }
    const failures: Record<string, number> = {};
    trials.flatMap((t) => t.failures).forEach((failure) => { failures[failure] = (failures[failure] ?? 0) + 1; });
    all.push({ id: testCase.id, critical: testCase.critical ?? false, n: k, passes: trials.filter((t) => t.passed).length, failures, trials });
  }
  return all;
}

export interface KReport {
  k: number;
  /** 下标 j = pass^(j+1)，各用例平均：随 k 增大单调下降，下降得越快越不稳定 */
  passHat: number[];
  passAtK: number;
  /** 所有试验合在一起的单次成功率及 Wilson 区间 */
  trialRate: number;
  interval: [number, number];
  flaky: string[];
  alwaysFail: string[];
  criticalNotReliable: string[];
  passed: boolean;
}

/**
 * 门禁：critical 用例要求 pass^k = 1（k 次全过），其余看 pass^1 是否达到阈值。
 * 只看 pass@k 会把“偶尔做对”当成“能做对”；Agent 上线后每个请求只有一次机会。
 */
export function gateK(results: CaseTrials[], minPassRate = 0.9): KReport {
  const k = results[0]?.n ?? 0;
  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / Math.max(values.length, 1);
  const passHat = Array.from({ length: k }, (_, j) => mean(results.map((r) => passHatK(r.n, r.passes, j + 1))));
  const successes = results.reduce((sum, r) => sum + r.passes, 0);
  const trials = results.reduce((sum, r) => sum + r.n, 0);
  const criticalNotReliable = results.filter((r) => r.critical && r.passes < r.n).map((r) => r.id);
  return {
    k,
    passHat,
    passAtK: mean(results.map((r) => passAtK(r.n, r.passes, r.n))),
    trialRate: successes / Math.max(trials, 1),
    interval: wilson(successes, trials),
    flaky: results.filter((r) => r.passes > 0 && r.passes < r.n).map((r) => r.id),
    alwaysFail: results.filter((r) => r.passes === 0).map((r) => r.id),
    criticalNotReliable,
    passed: k > 0 && criticalNotReliable.length === 0 && (passHat[0] ?? 0) >= minPassRate,
  };
}
