import { writeFileSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { createReliabilityModel } from '../reliability/model.ts';
import { createSearch } from '../retrieval/index.ts';
import { evalCases } from './cases.ts';
import { compareSnapshots, isPinnedModel, loadSnapshot, toSnapshot } from './drift.ts';
import { gateK, runTrials, wilson } from './passk.ts';

// 第 24 章 用法：K=5 STOCHASTIC=v1 npm run eval:k。每条用例跑 K 次，门禁看 pass^k 而不是单次通过率。
// 其他环境变量见 src/reliability/model.ts；EVAL_SNAPSHOT=路径 保存结果快照，EVAL_BASELINE=路径 和基线比较漂移。
const env = process.env;
const config = loadConfig(env);
const k = Number(env.K ?? 5);
if (!Number.isInteger(k) || k < 1) throw new Error(`K 必须是正整数，当前是 ${env.K}`);
const built = createReliabilityModel(env, config);
const search = createSearch(config);
console.log(`评测模型：${built.label}\n每条用例 ${k} 次，共 ${evalCases.length} 条用例\n`);

const results = await runTrials(evalCases, built.model, k, search);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
for (const r of results) {
  const [low, high] = wilson(r.passes, r.n);
  const dots = r.trials.map((t) => (t.passed ? '●' : '○')).join('');
  console.log(`${dots}  ${r.passes}/${r.n}  [${pct(low)}, ${pct(high)}]  ${r.critical ? '[critical] ' : ''}${r.id}`);
  Object.entries(r.failures).forEach(([failure, count]) => console.log(`        - ${failure} ×${count}`));
}

const report = gateK(results);
console.log(`
pass^k 曲线（各用例平均）：${report.passHat.map((v, j) => `k=${j + 1} ${v.toFixed(2)}`).join('　')}
pass@${k}：${report.passAtK.toFixed(2)}　pass^${k}：${report.passHat[k - 1].toFixed(2)}
单次成功率：${results.reduce((s, r) => s + r.passes, 0)}/${results.reduce((s, r) => s + r.n, 0)} = ${pct(report.trialRate)}，95% Wilson 区间 [${pct(report.interval[0])}, ${pct(report.interval[1])}]
不稳定（时过时不过）：${report.flaky.join(', ') || '无'}　一直失败：${report.alwaysFail.join(', ') || '无'}
critical 未做到 ${k} 次全过：${report.criticalNotReliable.join(', ') || '无'}`);

if (built.validator) {
  const s = built.validator.stats();
  console.log(`工具参数校验：${s.total} 次带工具调用的回复，一次通过 ${s.firstPass}，修复后通过 ${s.repaired}，修复失败 ${s.gaveUp}，额外模型调用 ${s.modelCalls - s.total}`);
}
if (built.stochastic) {
  console.log(`注入的扰动：${Object.entries(built.stochastic.injected).filter(([, n]) => n > 0).map(([kind, n]) => `${kind} ${n}`).join('　')}`);
}

let failed = !report.passed;
if (built.replay) {
  // 未命中时 Agent 把异常记成“内部错误”，只看用例结果会误以为是模型答错了，所以单独报出来
  built.replay.misses.slice(0, 3).forEach((miss) => console.log(`❌ ${miss.message}`));
  console.log(`回放：未命中 ${built.replay.misses.length} 次，未使用的录音 ${built.replay.unused()} 条`);
  if (built.replay.misses.length > 0 || built.replay.unused() > 0) failed = true;
}
if (built.recorder) {
  built.recorder.save(env.LLM_RECORD!);
  console.log(`已录制 ${built.recorder.fixture().entries.length} 次模型调用到 ${env.LLM_RECORD}`);
}

const snapshot = toSnapshot(results, { model: built.model.name, seed: env.STOCHASTIC ? Number(env.SEED ?? 1) : undefined });
if (env.EVAL_SNAPSHOT) {
  writeFileSync(env.EVAL_SNAPSHOT, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`快照已写入 ${env.EVAL_SNAPSHOT}`);
}
if (!isPinnedModel(built.model.name)) console.log(`⚠️ 模型 id ${built.model.name} 不是固定快照，结果不能和以后的评测直接比较`);
if (env.EVAL_BASELINE) {
  const baseline = loadSnapshot(env.EVAL_BASELINE);
  const drift = compareSnapshots(baseline, snapshot);
  console.log(`\n漂移检查：基线 ${baseline.model}（${baseline.date}，k=${baseline.k}）→ 当前 ${snapshot.model}`);
  drift.warnings.forEach((w) => console.log(`  ⚠️ ${w}`));
  for (const c of drift.cases.filter((c) => c.change !== 'unchanged' || c.before !== c.after)) {
    const mark = c.change === 'regressed' ? '退化' : c.change === 'improved' ? '改进' : '波动';
    console.log(`  ${mark}  ${c.critical ? '[critical] ' : ''}${c.id}  ${pct(c.before)} → ${pct(c.after)}  p=${c.pValue.toFixed(3)}`);
  }
  console.log(`  总体：${pct(drift.overall.before)} → ${pct(drift.overall.after)}  p=${drift.overall.pValue.toFixed(3)}`);
  if (drift.criticalBroken.length) console.log(`  critical 用例不再 ${k} 次全过：${drift.criticalBroken.join(', ')}`);
  console.log(`  结论：${drift.drifted ? '❌ 检测到漂移' : '✅ 没有统计上可信的变化'}`);
  if (drift.drifted) failed = true;
}

console.log(`\n结论：${failed ? '❌ 禁止发布' : '✅ 可以发布'}`);
process.exitCode = failed ? 1 : 0;
