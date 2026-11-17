import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { evalCases } from '../src/eval/cases.ts';
import { compareSnapshots, fisherExact, isPinnedModel, type Snapshot } from '../src/eval/drift.ts';
import { runCase } from '../src/eval/evaluate.ts';
import { gateK, passAtK, passHatK, runTrials, wilson, type CaseTrials } from '../src/eval/passk.ts';
import { createScriptedModel } from '../src/llm/mock.ts';
import type { ChatModel, ModelRequest } from '../src/llm/types.ts';
import { createRecordingModel, createReplayModel, ReplayMissError } from '../src/reliability/recorder.ts';
import { validate } from '../src/reliability/schema.ts';
import { createStochasticModel } from '../src/reliability/stochastic.ts';
import { checkToolCall, completeStructured, createToolArgValidator } from '../src/reliability/structured.ts';
import { triageMessages, triageSchema } from '../src/reliability/triage.ts';
import { Store } from '../src/store.ts';
import { createTools } from '../src/tools/index.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-3, `${actual} ≉ ${expected}`);

test('pass@k / pass^k 的无偏估计与 Wilson 区间', () => {
  close(passHatK(5, 4, 1), 0.8);
  close(passHatK(5, 4, 2), 0.6);
  assert.equal(passHatK(5, 4, 5), 0);
  assert.equal(passHatK(5, 5, 5), 1);
  close(passAtK(5, 1, 1), 0.2);
  assert.equal(passAtK(5, 1, 5), 1);
  assert.equal(passAtK(5, 0, 3), 0);
  assert.throws(() => passHatK(3, 3, 4));
  const [low0, high0] = wilson(0, 10);
  assert.equal(low0, 0);
  close(high0, 0.2775);
  const [low, high] = wilson(5, 10);
  close(low, 0.2366);
  close(high, 0.7634);
  // n 越大区间越窄
  assert.ok(wilson(50, 100)[1] - wilson(50, 100)[0] < high - low);
});

test('门禁看 critical 用例的 pass^k：单次通过率达标也会因一次失败被拦下', () => {
  const trials = (id: string, critical: boolean, passes: number): CaseTrials => ({ id, critical, n: 5, passes, failures: {}, trials: [] });
  const report = gateK([trials('a', false, 5), trials('b', false, 5), trials('c', true, 5), trials('d', true, 4)], 0.9);
  close(report.passHat[0], 0.95);
  assert.equal(report.passAtK, 1);
  assert.deepEqual(report.criticalNotReliable, ['d']);
  assert.deepEqual(report.flaky, ['d']);
  assert.equal(report.passed, false);
  assert.equal(gateK([trials('a', false, 5), trials('c', true, 5)]).passed, true);
});

test('随机扰动模型：同一种子结果完全相同，不同种子不同', async () => {
  const cases = evalCases.slice(0, 4);
  const dots = async (seed: number) => (await runTrials(cases, createStochasticModel({ seed }), 4)).map((r) => r.trials.map((t) => t.failures.join('|')).join('/'));
  const a = await dots(3);
  assert.deepEqual(await dots(3), a);
  const structured = async (seed: number) => {
    const model = createStochasticModel({ seed });
    const out: string[] = [];
    for (let i = 0; i < 20; i++) out.push((await model.complete({ messages: triageMessages('VPN 连不上，帮我报修'), responseFormat: { name: 't', schema: triageSchema } })).message.content);
    return out;
  };
  assert.deepEqual(await structured(5), await structured(5));
  assert.notDeepEqual(await structured(5), await structured(6));
  // 扰动确实发生了：同一个问题的 20 次输出不全相同
  assert.ok(new Set(await structured(5)).size > 1);
});

test('录制回放：命中时结果一致（草稿号按占位符换成当次的值），密钥不落盘', async () => {
  const quiet = createStochasticModel({ seed: 1, rates: { skipTool: 0, wrongTool: 0, malformedArgs: 0, paraphrase: 0 } });
  const recorder = createRecordingModel(quiet, { secrets: ['my-secret-123'] });
  const ticketCase = evalCases.find((c) => c.id === 'ticket-approved')!;
  assert.equal((await runCase(ticketCase, recorder)).passed, true);
  const fixture = recorder.fixture();
  assert.equal(fixture.entries.length, 4);
  assert.match(JSON.stringify(fixture), /draftId\\":\\"<v\d+>/, '回复里的草稿号应存成占位符');

  const replay = createReplayModel(JSON.parse(JSON.stringify(fixture)));
  const replayed = await runCase(ticketCase, replay);
  assert.equal(replayed.passed, true, replayed.failures.join('；'));
  assert.equal(replay.misses.length, 0);
  assert.equal(replay.unused(), 0);

  const leaky: ChatModel = { name: 'leaky', complete: async () => ({ message: { role: 'assistant', content: '配置：api_key=abc123xyz，sk-ABCDEFGHIJKLMNOPQRSTUV，口令 my-secret-123' }, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' }) };
  const leakyRecorder = createRecordingModel(leaky, { secrets: ['my-secret-123'] });
  await leakyRecorder.complete({ messages: [{ role: 'user', content: '密钥是 sk-ABCDEFGHIJKLMNOPQRSTUV' }] });
  const saved = JSON.stringify(leakyRecorder.fixture());
  for (const secret of ['abc123xyz', 'ABCDEFGHIJKLMNOPQRSTUV', 'my-secret-123']) assert.ok(!saved.includes(secret), `录音里出现了 ${secret}`);
});

test('录制回放：请求变了就报错并指出第一处不同，而不是返回旧回复', async () => {
  const recorder = createRecordingModel(createScriptedModel([{ content: '好的' }]));
  const request: ModelRequest = { messages: [{ role: 'system', content: '你是助手。今天是 2026-01-01。' }, { role: 'user', content: '你好' }] };
  await recorder.complete(request);
  const replay = createReplayModel(recorder.fixture());
  // 日期属于易变值，换一天仍然命中
  const nextDay: ModelRequest = { messages: [{ role: 'system', content: '你是助手。今天是 2026-01-02。' }, { role: 'user', content: '你好' }] };
  assert.equal((await replay.complete(nextDay)).message.content, '好的');
  await assert.rejects(replay.complete(nextDay), /已用完/);
  const changed: ModelRequest = { messages: [{ role: 'system', content: '你是严格的助手。今天是 2026-01-01。' }, { role: 'user', content: '你好' }] };
  await assert.rejects(createReplayModel(recorder.fixture()).complete(changed), (error: unknown) => error instanceof ReplayMissError && /第 1 条消息（system）/.test(error.message));
  const withTools: ModelRequest = { ...request, tools: [{ name: 'x', description: 'x', parameters: { type: 'object' } }] };
  await assert.rejects(createReplayModel(recorder.fixture()).complete(withTools), /工具定义或输出格式变了/);
});

test('schema 校验：类型、必填、枚举、长度、多余字段，未支持的关键字直接报错', () => {
  assert.deepEqual(validate(triageSchema, { category: 'it', priority: 'high', title: 'VPN', needsHuman: true }), []);
  const errors = validate(triageSchema, { category: 'IT', title: 'x'.repeat(31), needsHuman: 'yes', extra: 1 });
  assert.deepEqual(errors.map((e) => e.split(':')[0]).sort(), ['$.category', '$.extra', '$.needsHuman', '$.priority', '$.title']);
  assert.deepEqual(validate({ type: 'array', items: { type: 'integer' }, maxItems: 2 }, [1, 2.5, 3]), ['$: 最多 2 项（实际 3）', '$[1]: 应为 integer，实际是 number']);
  assert.deepEqual(validate({ type: ['string', 'null'] }, null), []);
  assert.throws(() => validate({ type: 'string', format: 'email' }, 'a@b.c'), /format/);
  // 项目里所有工具的参数 schema 都在支持的子集内
  const store = new Store(':memory:');
  const specs = createTools(store).map((tool) => tool.spec);
  assert.deepEqual(checkToolCall({ id: '1', name: 'prepare_ticket', arguments: '{"title":"VPN","description":"连不上","sourceIds":["a"]}' }, specs), []);
  assert.match(checkToolCall({ id: '1', name: 'search_knowledge', arguments: '{"query":"VPN' }, specs)[0], /不是合法 JSON/);
  assert.match(checkToolCall({ id: '1', name: 'search_knowledge', arguments: '{"draftId":"d"}' }, specs).join(), /query: 缺少必填字段/);
  assert.match(checkToolCall({ id: '1', name: 'delete_all', arguments: '{}' }, specs)[0], /没有名为 delete_all/);
  store.close();
});

test('修复循环：把校验错误发回模型，修好即返回；超过次数就放弃', async () => {
  const good = '{"category":"it","priority":"high","title":"VPN","needsHuman":true}';
  const seen: string[] = [];
  const fixes = createScriptedModel([
    { content: '{"category":"IT","priority":"high","title":"VPN","needsHuman":true}' },
    (messages) => { seen.push(messages.at(-1)!.content); return { content: good }; },
  ]);
  const ok = await completeStructured(fixes, triageMessages('VPN'), { name: 'triage', schema: triageSchema, maxRepairs: 2 });
  assert.equal(ok.ok, true);
  assert.equal(ok.attempts, 2);
  assert.match(seen[0], /\$\.category: 只能是/);

  const stubborn = createScriptedModel([{ content: '```json\n' + good + '\n```' }, { content: '好的：' + good }]);
  const gaveUp = await completeStructured(stubborn, triageMessages('VPN'), { name: 'triage', schema: triageSchema, maxRepairs: 1 });
  assert.equal(gaveUp.ok, false);
  assert.equal(gaveUp.attempts, 2);
  const lenient = await completeStructured(createScriptedModel([{ content: '```json\n' + good + '\n```' }]), triageMessages('VPN'), { name: 'triage', schema: triageSchema, maxRepairs: 0, lenient: true });
  assert.ok(lenient.ok && lenient.lenient);
});

test('工具参数校验包装：非法调用不交给 Agent，修复调用的 token 计入总用量', async () => {
  const store = new Store(':memory:');
  const tools = createTools(store).map((tool) => tool.spec);
  const inner = createScriptedModel([
    { toolCalls: [{ name: 'search_knowledge', args: { draftId: 'x' } }] },
    (messages) => {
      assert.match(messages.at(-1)!.content, /INVALID_ARGUMENTS.*query: 缺少必填字段/);
      return { toolCalls: [{ name: 'search_knowledge', args: { query: 'VPN' } }] };
    },
  ]);
  const usages: number[] = [];
  const counted: ChatModel = { name: 'counted', complete: async (request) => { const r = await inner.complete(request); usages.push(r.usage.inputTokens); return r; } };
  const validator = createToolArgValidator(counted);
  const response = await validator.complete({ messages: [{ role: 'user', content: 'VPN 连不上' }], tools });
  assert.equal(response.message.toolCalls?.[0].arguments, '{"query":"VPN"}');
  assert.equal(usages.length, 2);
  assert.equal(response.usage.inputTokens, usages[0] + usages[1]);
  assert.deepEqual(validator.stats(), { total: 1, firstPass: 0, repaired: 1, gaveUp: 0, lenient: 0, modelCalls: 2 });
  store.close();
});

test('漂移检测：critical 用例从 k 次全过变成不全过时直接告警；别名模型给出警告', () => {
  const snap = (model: string, passes: number[]): Snapshot => ({ model, date: '2026-11-17', k: 10, cases: passes.map((p, i) => ({ id: `c${i}`, critical: i === 0, n: 10, passes: p })) });
  const same = compareSnapshots(snap('m-2024-08-06', [10, 9]), snap('m-2024-08-06', [10, 8]));
  assert.equal(same.drifted, false);
  const broken = compareSnapshots(snap('m-2024-08-06', [10, 9]), snap('m-2024-08-06', [9, 9]));
  assert.deepEqual(broken.criticalBroken, ['c0']);
  assert.equal(broken.drifted, true);
  const big = compareSnapshots(snap('deepseek-chat', [10, 10]), snap('deepseek-chat', [10, 2]));
  assert.equal(big.cases[1].change, 'regressed');
  assert.ok(big.warnings.some((w) => w.includes('不是固定快照')));
  close(fisherExact(10, 0, 2, 8), 0.000714);
  assert.equal(isPinnedModel('gpt-4o-2024-08-06'), true);
  assert.equal(isPinnedModel('gpt-4o'), false);
});

test('npm run eval:k：critical 用例不能 k 次全过时进程以 1 退出，确定性 mock 以 0 退出', () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, ['src/eval/run-k.ts'], { env: { ...process.env, MODEL_PROVIDER: 'mock', RETRIEVAL: 'keyword', LLM_REPLAY: '', LLM_RECORD: '', VALIDATE_TOOLS: 'off', EVAL_BASELINE: '', EVAL_SNAPSHOT: '', ...env }, encoding: 'utf8' });
  const flaky = run({ STOCHASTIC: 'v1', SEED: '1', K: '5' });
  assert.equal(flaky.status, 1, flaky.stderr);
  assert.match(flaky.stdout, /critical 未做到 5 次全过：role-acl-denied/);
  assert.match(flaky.stdout, /禁止发布/);
  const stable = run({ STOCHASTIC: 'off', K: '2' });
  assert.equal(stable.status, 0, stable.stdout + stable.stderr);
});
