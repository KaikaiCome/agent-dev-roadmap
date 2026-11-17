// 第 22 章：从事件日志算 SLO（成功率、延迟分位数、每次 run 的成本、错误预算燃烧率）。
// 运行：npm run slo                       → 生成一组固定的模拟 run（离线、结果可复现），再计算
//       npm run slo -- data/agent.db      → 对真实的数据库计算最近 7 天
// 价格是示例值，换成你用的模型的真实价格。
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import { computeSlo, type SloOptions } from '../src/telemetry/slo.ts';

const DAY = 86_400_000;
const target = process.argv[2];
let path = target;
let to = new Date();
if (!path) {
  path = 'data/slo-demo.db';
  to = new Date('2025-06-08T00:00:00Z');
  seed(path, to);
} else if (!existsSync(path)) {
  console.error(`找不到数据库：${path}`);
  process.exit(1);
}

const options: SloOptions = {
  from: new Date(to.getTime() - 7 * DAY),
  to,
  prices: { input: 2, output: 8 },
  successTarget: 0.95,
  latencyP95Ms: 20_000,
  burnWindowsHours: [1, 6, 24, 7 * 24],
};
const db = new DatabaseSync(path, { readOnly: true });
const report = computeSlo(db, options);
db.close();

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const yuan = (x: number) => `¥${x.toFixed(4)}`;
console.log(`数据：${target ?? `${path}（模拟数据）`}  窗口：${options.from.toISOString().slice(0, 16)} → ${to.toISOString().slice(0, 16)}`);
console.log(`顶层 run ${report.runs} 个，计入 SLO ${report.good + report.bad} 个，不计入：${Object.entries(report.excluded).map(([k, v]) => `${k} ${v}`).join('，') || '无'}`);
console.log('');
console.log(`成功率      ${pct(report.successRate)}  （目标 ${pct(options.successTarget)}，成功 ${report.good} / 失败 ${report.bad}）`);
console.log(`延迟 p50    ${sec(report.latency.p50)}`);
console.log(`延迟 p95    ${sec(report.latency.p95)}  （目标 ≤ ${sec(options.latencyP95Ms)}，超标的 run ${pct(report.latency.slowRatio)}；不扣审批等待的 p95 是 ${sec(report.latency.wallP95)}）`);
console.log(`每次 run    ${yuan(report.cost.perRun)}  （p95 ${yuan(report.cost.p95)}，合计 ${yuan(report.cost.total)}，含子 Agent）`);
console.log(`错误预算    允许失败 ${report.budget.allowedBad.toFixed(1)} 次，已用 ${pct(report.budget.consumed)}`);
console.log('');
console.log('燃烧率（窗口失败率 ÷ 允许失败率；1 = 刚好在周期末用完）');
for (const b of report.burn) {
  const label = b.hours >= 24 ? `${b.hours / 24} 天` : `${b.hours} 小时`;
  console.log(`  最近 ${label.padEnd(5)} run ${String(b.runs).padStart(3)}  失败 ${String(b.bad).padStart(2)}  燃烧率 ${b.rate.toFixed(1)}`);
}
console.log('');
console.log('失败原因');
for (const [reason, count] of report.topReasons) console.log(`  ${String(count).padStart(3)}  ${reason}`);

/** 生成 7 天的模拟 run：大部分正常，最近几小时模型服务出故障。用固定种子，每次结果一样 */
function seed(file: string, end: Date) {
  mkdirSync('data', { recursive: true });
  rmSync(file, { force: true });
  new Store(file).close();
  const db = new DatabaseSync(file);
  let state = 22;
  const random = () => ((state = (state * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  const iso = (ms: number) => new Date(ms).toISOString();
  const insertRun = db.prepare('INSERT INTO runs (id, tenant_id, user_id, question, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertEvent = db.prepare('INSERT INTO events (run_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)');
  const insertLink = db.prepare('INSERT INTO run_links (child_run_id, parent_run_id, parent_call_id, agent) VALUES (?, ?, ?, ?)');

  const addRun = (id: string, startMs: number, status: string, events: Array<[number, string, object]>) => {
    const last = events.at(-1)?.[0] ?? startMs;
    insertRun.run(id, 'acme', 'alice', '（模拟）', status, iso(startMs), iso(last));
    events.forEach(([at, type, data], seq) => insertEvent.run(id, seq + 1, type, JSON.stringify(data), iso(at)));
  };
  const usage = (at: number) => [at, 'usage', { model: 'deepseek-chat', inputTokens: 1500 + Math.floor(random() * 3000), outputTokens: 100 + Math.floor(random() * 400), latencyMs: 0 }] as [number, string, object];

  const links: string[][] = [];
  db.exec('BEGIN');
  const start = end.getTime() - 7 * DAY;
  for (let i = 0; i < 400; i++) {
    const id = `run_${String(i).padStart(3, '0')}`;
    const t0 = start + Math.floor((i / 400) * 7 * DAY + random() * 600_000);
    const incident = end.getTime() - t0 < 5 * 3_600_000 && random() < 0.35;
    const roll = random();
    const events: Array<[number, string, object]> = [[t0, 'run_started', { question: '（模拟）', userId: 'alice' }]];
    let t = t0 + 2000 + Math.floor(random() * 6000);
    events.push(usage(t));
    let status = 'completed';
    if (incident) {
      status = 'failed';
      events.push([t + 30_000, 'run_finished', { status, reason: '模型调用失败：503 Service Unavailable' }]);
    } else if (roll < 0.02) {
      status = 'budget_exceeded';
      for (let k = 0; k < 6; k++) events.push(usage((t += 4000)));
      events.push([t, 'run_finished', { status, reason: '超过最多 8 步' }]);
    } else if (roll < 0.035) {
      status = 'failed';
      events.push([t + 1000, 'run_finished', { status, reason: '工具 search_knowledge 连续失败' }]);
    } else if (roll < 0.06) {
      status = 'cancelled';
      events.push([t + 500, 'run_finished', { status, reason: '员工取消' }]);
    } else {
      if (roll < 0.2) {
        // 需要审批：员工几分钟后才点批准，这段时间不该算进 Agent 的延迟
        const callId = `call_${i}`;
        events.push([t, 'approval_requested', { callId, name: 'create_ticket', args: {}, summary: '', expiresAt: iso(t + DAY) }]);
        t += 60_000 + Math.floor(random() * 600_000);
        events.push([t, 'approval_resolved', { callId, approved: true, userId: 'alice' }]);
      }
      if (roll > 0.85) {
        // 子 Agent：它的 token 也要算到这次 run 的成本里
        const childId = `${id}_research`;
        insertRun.run(childId, 'acme', 'alice', '（模拟）', 'completed', iso(t), iso(t + 5000));
        [usage(t + 2500), usage(t + 5000)].forEach(([at, type, data], seq) => insertEvent.run(childId, seq + 1, type, JSON.stringify(data), iso(at)));
        links.push([childId, id, `call_r${i}`]);
        t += 6000;
      }
      // 少数 run 很慢（模型排队、长输出），撑出长尾
      t += random() < 0.07 ? 15_000 + Math.floor(random() * 25_000) : 1000 + Math.floor(random() * 6000);
      events.push(usage(t));
      events.push([t, 'run_finished', { status }]);
    }
    addRun(id, t0, status, events);
  }
  links.forEach(([child, parent, callId]) => insertLink.run(child, parent, callId, 'research'));
  // 两分钟前刚开始、还在跑的 run：不算失败
  addRun('run_fresh', end.getTime() - 2 * 60_000, 'running', [[end.getTime() - 2 * 60_000, 'run_started', { question: '（模拟）', userId: 'alice' }]]);
  // 一个卡住的 run：40 分钟前开始，一直没有结束事件
  addRun('run_stuck', end.getTime() - 40 * 60_000, 'running', [[end.getTime() - 40 * 60_000, 'run_started', { question: '（模拟）', userId: 'alice' }]]);
  // 一个等审批的 run：不算失败
  addRun('run_waiting', end.getTime() - 2 * 3_600_000, 'waiting_approval', [[end.getTime() - 2 * 3_600_000, 'run_started', { question: '（模拟）', userId: 'alice' }]]);
  db.exec('COMMIT');
  db.close();
}
