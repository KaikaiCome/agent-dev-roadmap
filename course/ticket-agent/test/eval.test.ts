import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evalCases } from '../src/eval/cases.ts';
import { gate, runCase, type CaseResult } from '../src/eval/evaluate.ts';
import { createMockModel, createScriptedModel } from '../src/llm/mock.ts';

test('离线模型通过全部评测用例', async () => {
  const model = createMockModel();
  const results = [];
  for (const testCase of evalCases) results.push(await runCase(testCase, model));
  assert.deepEqual(results.filter((r) => !r.passed).map((r) => [r.id, r.failures]), []);
  assert.equal(gate(results).passed, true);
});

test('模型不检索就凭空回答，会被评测抓住', async () => {
  const lazy = createScriptedModel([{ content: '每晚 1000 元。' }]);
  const result = await runCase(evalCases[0], lazy);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.includes('没有引用')));
});

test('不检索却伪造引用编号，也会被评测抓住', async () => {
  const forger = createScriptedModel([{ content: '一线城市每晚 500 元 [acme-travel@v2]。' }]);
  const result = await runCase(evalCases[0], forger);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.includes('不是本次检索返回的结果')), result.failures.join('; '));
});

test('引用正确但关键事实错误，也会被评测抓住', async () => {
  const wrong = createScriptedModel([
    { toolCalls: [{ name: 'search_knowledge', args: { query: '差旅住宿报销上限' } }] },
    { content: '每晚 600 元 [acme-travel@v2]。' },
  ]);
  const result = await runCase(evalCases[0], wrong);
  assert.equal(result.passed, false);
  assert.deepEqual(result.failures.filter((f) => f.includes('引用')), []);
  assert.ok(result.failures.some((f) => f.includes('500 元')), result.failures.join('; '));
});

test('任何一条 critical 失败都会阻止发布，即使通过率很高', () => {
  const base = { failures: [], status: 'completed', inputTokens: 0, outputTokens: 0, latencyMs: 10 };
  const results: CaseResult[] = Array.from({ length: 20 }, (_, i) => ({ ...base, id: `c${i}`, critical: i === 0, passed: i !== 0 }));
  const report = gate(results);
  assert.equal(report.passRate, 0.95);
  assert.deepEqual(report.criticalFailures, ['c0']);
  assert.equal(report.passed, false);
});
