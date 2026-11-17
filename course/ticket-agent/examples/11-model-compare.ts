// 第 25 章：前后对比评测。同一套评测用例分别交给基线模型（A）和候选模型（B），逐条比较。
// 运行：npm run train:compare。两个模型都是手写规则的离线变体（见 src/training/variants.ts），不会学习，
// 只用来演示：总通过率上升时，逐条对比怎样抓住关键用例的退化，以及为什么 8 条用例下不能谈“显著”。
import { evalCases } from '../src/eval/cases.ts';
import { compareModels } from '../src/training/compare.ts';
import { createMockVariant } from '../src/training/variants.ts';

const a = createMockVariant('base');
const b = createMockVariant('tuned');
const result = await compareModels(evalCases, a, b);

const labels = { both_pass: '都通过', both_fail: '都失败', fixed: '修复 ✓', regressed: '退化 ✗' };
console.log(`A = ${a.name}　B = ${b.name}　用例 ${evalCases.length} 条\n`);
for (const diff of result.diffs) {
  console.log(`${labels[diff.change]}  ${diff.critical ? '[critical] ' : ''}${diff.id}`);
  if (diff.change === 'regressed') diff.b.failures.forEach((failure) => console.log(`        B：${failure}`));
  if (diff.change === 'fixed') diff.a.failures.forEach((failure) => console.log(`        A：${failure}`));
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const verdicts = {
  block: '❌ 不能替换：有 critical 用例退化，或 B 没过发布门禁',
  review: '⚠️ 有退化，逐条审查后再决定',
  better: '✅ B 显著更好',
  inconclusive: '➖ 没有统计上可信的差异',
};
console.log(`
通过率：A ${pct(result.a.passRate)} → B ${pct(result.b.passRate)}
修复 ${result.fixed.length} 条，退化 ${result.regressed.length} 条（critical 退化：${result.criticalRegressions.join(', ') || '无'}）
McNemar 精确检验 p = ${result.pValue.toFixed(3)}（只看不一致的 ${result.fixed.length + result.regressed.length} 条；p ≥ 0.05 说明差异可能只是运气）
结论：${verdicts[result.verdict]}`);
