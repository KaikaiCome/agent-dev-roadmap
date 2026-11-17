import type { DatabaseSync } from 'node:sqlite';

// 第 22 章：直接从事件日志（runs / events / run_links 三张表）计算 SLO。
// trace 适合排查单个请求，但会被采样、会丢；SLO 要算“全部请求里有多少成功”，必须用不采样、不丢的数据源。
// 本项目的事件日志正好就是这样的数据源：每个 run 的开始、结束、用量、审批都在里面。

export interface SloOptions {
  from: Date;
  to: Date;
  /** 元 / 百万 token */
  prices: { input: number; output: number };
  /** 成功率目标，例如 0.95 */
  successTarget: number;
  /** 延迟目标：p95 不超过多少毫秒（审批等待不计入） */
  latencyP95Ms: number;
  /** 还在 running 但已经超过这么久的 run 算失败（卡住）。不算的话，最糟糕的故障反而不出现在报表里 */
  stuckAfterMs?: number;
  /** 计算燃烧率的时间窗口（小时），从 to 往前数 */
  burnWindowsHours?: number[];
}

export interface RunOutcome {
  id: string;
  createdMs: number;
  outcome: 'good' | 'bad' | 'excluded';
  reason?: string;
  /** 只对已结束的 run 有值：结束时间 - 开始时间 - 审批等待 */
  latencyMs?: number;
  /** 不扣除审批等待的延迟，用来对比 */
  wallMs?: number;
  /** 整棵调用树（包括子 Agent）的成本 */
  cost: number;
}

export interface SloReport {
  runs: number;
  excluded: Record<string, number>;
  good: number;
  bad: number;
  successRate: number;
  latency: { p50: number; p95: number; wallP95: number; slowRatio: number };
  cost: { total: number; perRun: number; p95: number };
  budget: { allowedBad: number; consumed: number };
  burn: Array<{ hours: number; runs: number; bad: number; rate: number }>;
  topReasons: Array<[string, number]>;
}

type Row = Record<string, unknown>;

export function runOutcomes(db: DatabaseSync, options: SloOptions): RunOutcome[] {
  const stuckAfterMs = options.stuckAfterMs ?? 10 * 60_000;
  const parentOf = new Map((db.prepare('SELECT child_run_id, parent_run_id FROM run_links').all() as Row[]).map((r) => [String(r.child_run_id), String(r.parent_run_id)]));
  const rootOf = (id: string): string => (parentOf.has(id) ? rootOf(parentOf.get(id)!) : id);

  // 顶层 run 才是用户感知到的“一次请求”；子 Agent 的 run 只把成本算到它的根上
  const runs = (db.prepare('SELECT id, status, created_at FROM runs WHERE created_at >= ? AND created_at < ? ORDER BY created_at')
    .all(options.from.toISOString(), options.to.toISOString()) as Row[]).filter((r) => !parentOf.has(String(r.id)));
  const byRoot = new Map(runs.map((r) => [String(r.id), { finishedMs: undefined as number | undefined, reason: undefined as string | undefined, approvalMs: 0, cost: 0, requested: new Map<string, number>() }]));

  const events = db.prepare(`SELECT run_id, type, data, created_at FROM events
    WHERE type IN ('usage', 'run_finished', 'approval_requested', 'approval_resolved') ORDER BY run_id, seq`).all() as Row[];
  for (const event of events) {
    const runId = String(event.run_id);
    const entry = byRoot.get(rootOf(runId));
    if (!entry) continue;
    const data = JSON.parse(String(event.data));
    const at = Date.parse(String(event.created_at));
    if (event.type === 'usage') entry.cost += (data.inputTokens * options.prices.input + data.outputTokens * options.prices.output) / 1_000_000;
    if (runId !== rootOf(runId)) continue;
    if (event.type === 'run_finished') {
      entry.finishedMs = at;
      entry.reason = data.reason;
    }
    if (event.type === 'approval_requested') entry.requested.set(data.callId, at);
    if (event.type === 'approval_resolved') entry.approvalMs += at - (entry.requested.get(data.callId) ?? at);
  }

  return runs.map((run) => {
    const id = String(run.id);
    const status = String(run.status);
    const createdMs = Date.parse(String(run.created_at));
    const entry = byRoot.get(id)!;
    const base = { id, createdMs, cost: entry.cost };
    if (status === 'completed') {
      const wallMs = entry.finishedMs! - createdMs;
      return { ...base, outcome: 'good', wallMs, latencyMs: wallMs - entry.approvalMs };
    }
    if (status === 'failed' || status === 'budget_exceeded') return { ...base, outcome: 'bad', reason: `${status}：${entry.reason ?? '未知'}` };
    if (status === 'running' && options.to.getTime() - createdMs > stuckAfterMs) return { ...base, outcome: 'bad', reason: `卡住：超过 ${stuckAfterMs / 60_000} 分钟未结束` };
    // 用户取消、等员工审批、刚开始还在跑：不算成功也不算失败
    return { ...base, outcome: 'excluded', reason: status };
  });
}

export function computeSlo(db: DatabaseSync, options: SloOptions): SloReport {
  const outcomes = runOutcomes(db, options);
  const eligible = outcomes.filter((o) => o.outcome !== 'excluded');
  const good = eligible.filter((o) => o.outcome === 'good');
  const bad = eligible.length - good.length;
  const excluded: Record<string, number> = {};
  outcomes.filter((o) => o.outcome === 'excluded').forEach((o) => { excluded[o.reason!] = (excluded[o.reason!] ?? 0) + 1; });

  const latencies = good.map((o) => o.latencyMs!);
  const costs = eligible.map((o) => o.cost);
  const allowedBad = (1 - options.successTarget) * eligible.length;
  const reasons = new Map<string, number>();
  eligible.filter((o) => o.reason).forEach((o) => reasons.set(o.reason!, (reasons.get(o.reason!) ?? 0) + 1));

  return {
    runs: outcomes.length,
    excluded,
    good: good.length,
    bad,
    successRate: eligible.length ? good.length / eligible.length : 1,
    latency: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      wallP95: percentile(good.map((o) => o.wallMs!), 0.95),
      slowRatio: latencies.length ? latencies.filter((ms) => ms > options.latencyP95Ms).length / latencies.length : 0,
    },
    cost: { total: sum(costs), perRun: costs.length ? sum(costs) / costs.length : 0, p95: percentile(costs, 0.95) },
    budget: { allowedBad, consumed: allowedBad > 0 ? bad / allowedBad : bad > 0 ? Infinity : 0 },
    // 燃烧率 = 窗口内的失败率 ÷ 允许的失败率。1 表示按这个速度，预算正好在整个 SLO 周期结束时用完
    burn: (options.burnWindowsHours ?? [1, 6, 24]).map((hours) => {
      const since = options.to.getTime() - hours * 3_600_000;
      const inWindow = eligible.filter((o) => o.createdMs >= since);
      const badInWindow = inWindow.filter((o) => o.outcome === 'bad').length;
      return { hours, runs: inWindow.length, bad: badInWindow, rate: inWindow.length ? badInWindow / inWindow.length / (1 - options.successTarget) : 0 };
    }),
    topReasons: [...reasons].sort((a, b) => b[1] - a[1]),
  };
}

/** 最近秩法：p95 就是排序后第 ceil(0.95 n) 个值，一定是真实出现过的值 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
