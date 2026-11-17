// 第 21 章：红队评测 + CI 门禁。每条攻击分别在“不开护栏”和“开护栏”下运行，统计各类攻击的得逞率。
// 运行：npm run redteam（离线；模型是 createVulnerableModel——一个会照做注入指令的假模型，模拟“模型已被攻破”的最坏情况）
// 退出码：开启护栏后仍有 critical 攻击得逞，或正常请求被误伤，返回 1，CI 据此阻止合并。
import { redTeamCases, owaspNames } from '../src/redteam/cases.ts';
import { runRedTeamSuite, type Owasp } from '../src/redteam/harness.ts';
import { createVulnerableModel } from '../src/redteam/vulnerable-model.ts';

const width = (text: string) => [...text].reduce((w, ch) => w + (ch.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0);
const pad = (text: string, size: number) => text + ' '.repeat(Math.max(0, size - width(text)));

const report = await runRedTeamSuite(redTeamCases, createVulnerableModel());
const attacks = report.rows.filter((row) => row.testCase.owasp !== 'BENIGN');
const benign = report.rows.filter((row) => row.testCase.owasp === 'BENIGN');

console.log(`模型：mock-vulnerable（照做注入指令的假模型）　攻击 ${attacks.length} 条，正常请求 ${benign.length} 条`);
console.log('审批人设定：看都不看就点同意（确认疲劳的最坏情况）\n');

console.log(pad('类别', 28), pad('用例', 6), pad('无护栏得逞', 12), '有护栏得逞');
const categories = [...new Set(attacks.map((row) => row.testCase.owasp))].sort() as Owasp[];
for (const category of categories) {
  const rows = attacks.filter((row) => row.testCase.owasp === category);
  const before = rows.filter((row) => row.baseline.length).length;
  const after = rows.filter((row) => row.guarded.length).length;
  console.log(pad(`${category} ${owaspNames[category]}`, 28), pad(String(rows.length), 6), pad(`${before}/${rows.length}`, 12), `${after}/${rows.length}`);
}
const before = attacks.filter((row) => row.baseline.length).length;
const after = attacks.filter((row) => row.guarded.length).length;
const rate = (n: number) => `${Math.round((n / attacks.length) * 100)}%`;
console.log(pad('合计', 28), pad(String(attacks.length), 6), pad(`${before}/${attacks.length} ${rate(before)}`, 12), `${after}/${attacks.length} ${rate(after)}`);

console.log('\n逐条结果（✗ = 攻击得逞，✓ = 守住）：');
for (const row of attacks) {
  const who = row.guarded.length
    ? `仍然得逞：${row.guarded.join('；')}${row.testCase.critical ? '' : '（已知残余风险）'}`
    : row.baseline.length ? row.rules.join(' ') : `结构性防御（不开护栏也守住）${row.rules.length ? `；护栏另外触发 ${row.rules.join(' ')}` : ''}`;
  console.log(pad(row.testCase.id, 26), pad(row.baseline.length ? '✗' : '✓', 3), pad(row.guarded.length ? '✗' : '✓', 3), who);
}

console.log(`\n正常请求被误伤：${benign.filter((row) => row.guarded.length).length}/${benign.length}`);
benign.filter((row) => row.guarded.length).forEach((row) => console.log(`- ${row.testCase.id}：${row.guarded.join('；')}`));

if (report.gateFailures.length) {
  console.log('\n门禁：❌ 不通过');
  report.gateFailures.forEach((failure) => console.log(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log('\n门禁：✅ 通过（critical 攻击全部守住，正常请求无误伤）');
}
