// 第 19 章：长期记忆的多会话基准。同一组场景分别在“没有记忆”“天真的记忆”“有策略的记忆”下运行。
// 运行：npm run bench:memory（离线 mock 模型；假模型只会原样引用记忆，数字只说明机制，不代表真实模型的效果）
import { createMockModel } from '../src/llm/mock.ts';
import { memoryScenarios, runMemoryScenario, type MemoryVariant } from '../src/eval/memory.ts';

const variants: Array<[MemoryVariant, string]> = [
  ['none', '无记忆'],
  ['naive', '天真记忆'],
  ['policy', '有策略的记忆'],
];
const model = createMockModel();

console.log(`场景 ${memoryScenarios.length} 个；天真记忆 = 同一项只追加不覆盖、写入和读取都不筛查、不要求员工原话\n`);
// 终端里中文占两列，按显示宽度补空格才能对齐
const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - [...text].reduce((w, ch) => w + (ch.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0)));
console.log(pad('场景', 28), ...variants.map(([, label]) => pad(label, 14)));

const totals = new Map<MemoryVariant, { passed: number; tokens: number }>(variants.map(([v]) => [v, { passed: 0, tokens: 0 }]));
const failures: string[] = [];
for (const scenario of memoryScenarios) {
  const cells: string[] = [];
  for (const [variant, label] of variants) {
    const result = await runMemoryScenario(scenario, model, variant);
    const total = totals.get(variant)!;
    total.passed += result.passed ? 1 : 0;
    total.tokens += result.tokens;
    cells.push(pad(result.passed ? '✓' : '✗', 14));
    result.failures.forEach((failure) => failures.push(`${label} / ${scenario.title}：${failure}`));
  }
  console.log(pad(scenario.title, 28), ...cells);
}
console.log(pad('通过', 28), ...variants.map(([v]) => pad(`${totals.get(v)!.passed}/${memoryScenarios.length}`, 14)));
console.log(pad('token 合计', 28), ...variants.map(([v]) => pad(String(totals.get(v)!.tokens), 14)));
console.log('\n失败原因：');
failures.forEach((line) => console.log(`- ${line}`));
