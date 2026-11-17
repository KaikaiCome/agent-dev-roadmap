// 第 24 章：结构化输出的校验与修复。同一个随机扰动模型（固定种子），分别用四种策略做工单分诊，
// 比较格式合格率、修复率、额外调用和 token。运行：npm run structured
// 模型是离线 mock，错误比例是人为设定的（见 src/reliability/stochastic.ts），只用来演示指标怎么算、怎么读。
import { createStochasticModel } from '../src/reliability/stochastic.ts';
import { completeStructured, emptyRepairStats, recordRepair } from '../src/reliability/structured.ts';
import { triageInputs, triageMessages, triageSchema, type Triage } from '../src/reliability/triage.ts';

const repeats = 5;
const strategies = [
  { label: '严格解析，不修复', lenient: false, maxRepairs: 0 },
  { label: '宽松解析，不修复', lenient: true, maxRepairs: 0 },
  { label: '严格解析，最多修 2 次', lenient: false, maxRepairs: 2 },
  { label: '宽松解析，最多修 2 次', lenient: true, maxRepairs: 2 },
];

console.log(`任务：工单分诊（${triageInputs.length} 条输入 × ${repeats} 次 = ${triageInputs.length * repeats} 次请求），模型 mock-stochastic-v1，每个请求独立种子\n`);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
console.log('合格  一次过  修复后过  放弃  宽松解析  分类错  调用/请求  token   策略');
const pad = (value: string | number, width: number) => String(value).padStart(width);
let baselineTokens = 0;
for (const strategy of strategies) {
  const stats = emptyRepairStats();
  let tokens = 0;
  let wrongLabel = 0;
  const lastErrors = new Map<string, number>();
  for (let round = 0; round < repeats; round++) {
    for (const [i, input] of triageInputs.entries()) {
      // 每个请求一个独立种子：四种策略第一次拿到的输出完全相同，差别只来自解析和修复
      const model = createStochasticModel({ seed: 7_000 + round * 100 + i });
      const result = await completeStructured<Triage>(model, triageMessages(input.question), { name: 'triage', schema: triageSchema, ...strategy });
      recordRepair(stats, result);
      tokens += result.usage.inputTokens + result.usage.outputTokens;
      if (result.ok && result.value.category !== input.category) wrongLabel += 1;
      if (!result.ok) {
        const kind = result.errors[0].replace(/（[\s\S]*$|，实际[\s\S]*$/, '');
        lastErrors.set(kind, (lastErrors.get(kind) ?? 0) + 1);
      }
    }
  }
  baselineTokens ||= tokens;
  const ok = (stats.firstPass + stats.repaired) / stats.total;
  console.log(`${pad(pct(ok), 4)}  ${pad(stats.firstPass, 6)}  ${pad(stats.repaired, 8)}  ${pad(stats.gaveUp, 4)}  ${pad(stats.lenient, 8)}  ${pad(wrongLabel, 6)}  ${pad((stats.modelCalls / stats.total).toFixed(2), 9)}  ${pad(`+${((tokens / baselineTokens - 1) * 100).toFixed(0)}%`, 5)}   ${strategy.label}`);
  if (lastErrors.size) console.log(`      放弃的请求，第一条错误：${[...lastErrors].map(([e, n]) => `${e} ×${n}`).join('；')}`);
}
console.log('\n合格 = 通过 schema 校验的比例；分类错 = 格式合格但 category 和标注不一致（schema 抓不到，要靠评测）。');
