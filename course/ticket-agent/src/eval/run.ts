import { loadConfig } from '../config.ts';
import { createModel } from '../llm/index.ts';
import { createSearch } from '../retrieval/index.ts';
import { evalCases } from './cases.ts';
import { gate, runCase, type CaseResult } from './evaluate.ts';

// 用法：npm run eval。失败时进程退出码为 1，可直接放进 CI 阻止发布
const config = loadConfig();
const model = createModel(config);
const search = createSearch(config);
console.log(`评测模型：${model.name === 'mock' ? 'mock（离线模拟）' : config.model}，检索：${config.retrieval}${config.subagent ? '，子 Agent：research' : ''}，共 ${evalCases.length} 条用例\n`);

const results: CaseResult[] = [];
for (const testCase of evalCases) {
  const result = await runCase(testCase, model, search, { subagent: config.subagent });
  results.push(result);
  const mark = result.passed ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${result.critical ? '[critical] ' : ''}${result.id}  ${result.latencyMs}ms`);
  result.failures.forEach((failure) => console.log(`      - ${failure}`));
}

const report = gate(results, { input: config.priceInputPerMTok, output: config.priceOutputPerMTok });
console.log(`
通过率：${(report.passRate * 100).toFixed(0)}%（门槛 90%）
critical 失败：${report.criticalFailures.length ? report.criticalFailures.join(', ') : '无'}
token 总量：${report.totalTokens}　估算成本：${report.cost.toFixed(4)} 元（按 .env 中的单价）
延迟：p50 ${report.p50Ms}ms　p95 ${report.p95Ms}ms
结论：${report.passed ? '✅ 可以发布' : '❌ 禁止发布'}`);
process.exitCode = report.passed ? 0 : 1;
