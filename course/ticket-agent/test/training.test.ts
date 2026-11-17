import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveApproval, runAgent } from '../src/agent.ts';
import type { User } from '../src/data/seed.ts';
import { evalCases } from '../src/eval/cases.ts';
import { createMockModel } from '../src/llm/mock.ts';
import { systemPrompt } from '../src/prompt.ts';
import { Store, type Run } from '../src/store.ts';
import { createTools } from '../src/tools/index.ts';
import { compareModels, mcnemarExact, summarize, type CaseDiff } from '../src/training/compare.ts';
import { buildPreferencePairs, toOpenAIDpo, type PreferenceGroup } from '../src/training/preference.ts';
import { containsPii, emptyStats, redact } from '../src/training/redact.ts';
import { exportSft, loadRuns, toJsonl, validateSftExample, type ExportOptions, type Feedback, type SftExample } from '../src/training/sft.ts';
import { createMockVariant } from '../src/training/variants.ts';

const employee = (id: string, tenantId = 'acme', name = `员工${id}`): User => ({ id, name, tenantId, roles: ['employee'] });

/** 用 mock 模型跑出一段运行日志；每个 run 默认得到一个赞 */
async function makeLog(sessions: Array<{ user: User; question: string; approve?: boolean; rating?: Feedback['rating'] | null }>) {
  const store = new Store(':memory:');
  const options = { model: createMockModel(), store, tools: createTools(store) };
  const feedback: Feedback[] = [];
  for (const { user, question, approve = true, rating = 'up' } of sessions) {
    const run = store.createRun(user, question);
    let status = await runAgent(run.id, user, options);
    while (status === 'waiting_approval') {
      const request = store.events(run.id).findLast((e) => e.type === 'approval_requested');
      assert.ok(request?.type === 'approval_requested');
      resolveApproval(store, run.id, user, request.data.callId, approve);
      status = await runAgent(run.id, user, options);
    }
    if (rating) feedback.push({ runId: run.id, rating, source: 'human' });
  }
  const records = loadRuns(store);
  const users = new Map(sessions.map((s) => [s.user.id, s.user]));
  const exportOptions: ExportOptions = {
    tools: options.tools.map((tool) => tool.spec),
    systemPrompt: (run: Run) => systemPrompt(users.get(run.userId)!, new Date(run.createdAt)),
    feedback,
    knownNames: [...users.values()].map((u) => u.name),
  };
  store.close();
  return { records, feedback, exportOptions };
}

test('脱敏：邮箱、手机号（含 +86 和被截断的）、身份证、座机、已知姓名都被替换，身份证不会被拆成手机号', () => {
  const stats = emptyStats();
  const text = '我是张伟，手机 13812345678，备用 +86 13900001111，座机 010-62345678，邮箱 zhang.wei@acme.cn，身份证 11010519900307123X，标题里的半截号码 13812345';
  const result = redact(text, stats, ['张伟']);
  assert.equal(result, '我是<NAME>，手机 <PHONE>，备用 <PHONE>，座机 <PHONE>，邮箱 <EMAIL>，身份证 <ID_NUMBER>，标题里的半截号码 <NUMBER>');
  assert.deepEqual(stats, { email: 1, phone: 3, idNumber: 1, longNumber: 1, name: 1 });
  assert.equal(containsPii(result, ['张伟']), false);
  assert.equal(containsPii('联系 13812345678'), true);
});

test('SFT 导出：每行是合法 JSON，工具调用与结果一一配对，随机 id 换成稳定编号且前后一致，不含个人信息', async () => {
  const user = employee('e01', 'acme', '张伟');
  const { records, exportOptions } = await makeLog([{ user, question: 'VPN 连不上，帮我提交 IT 工单，手机 13812345678' }]);
  const { train, validation } = exportSft(records, { ...exportOptions, valFraction: 0 });
  assert.equal(validation.length, 0);
  const lines = toJsonl(train).trimEnd().split('\n');
  assert.equal(lines.length, 1);
  const example = JSON.parse(lines[0]) as SftExample;
  assert.deepEqual(validateSftExample(example), []);
  assert.ok(!/13812345678|张伟|mock_\d|draft_[0-9a-f]{8}|TCK-[A-Z0-9]+-[0-9a-f]{4}/.test(lines[0]), lines[0]);

  const calls = example.messages.flatMap((m) => (m.role === 'assistant' ? m.tool_calls ?? [] : []));
  assert.deepEqual(calls.map((c) => [c.id, c.function.name]), [['call_1', 'search_knowledge'], ['call_2', 'prepare_ticket'], ['call_3', 'create_ticket']]);
  example.messages.forEach((message, i) => {
    if (message.role !== 'assistant' || !message.tool_calls) return;
    // 工具结果紧跟在发起调用的 assistant 消息后面，tool_call_id 对得上
    const results = example.messages.slice(i + 1, i + 1 + message.tool_calls.length);
    assert.deepEqual(results.map((r) => (r.role === 'tool' ? r.tool_call_id : r.role)), message.tool_calls.map((c) => c.id));
  });
  const draftResult = example.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_2');
  assert.ok(draftResult?.role === 'tool' && draftResult.content.includes('draft_0001'));
  assert.equal(JSON.parse(calls[2].function.arguments).draftId, 'draft_0001');
  assert.equal(example.messages.at(-1)?.role, 'assistant');
});

test('格式检查能发现配对损坏：缺结果、孤立的 tool 消息、未定义的工具、最后一条不是回答', () => {
  const tools = [{ type: 'function' as const, function: { name: 'search_knowledge', description: '', parameters: {} } }];
  const broken: SftExample = {
    tools,
    messages: [
      { role: 'user', content: '问题' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_knowledge', arguments: '{}' } }] },
      { role: 'assistant', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'delete_all', arguments: 'not json' } }] },
      { role: 'tool', tool_call_id: 'call_9', content: '{}' },
    ],
  };
  const errors = validateSftExample(broken).join('\n');
  for (const expected of ['call_1 没有结果', 'tools 里没有的工具 delete_all', '不是合法 JSON', 'call_9 没有对应的调用', '最后一条必须是 assistant']) {
    assert.ok(errors.includes(expected), `缺少错误「${expected}」：\n${errors}`);
  }
});

test('过滤：退出训练的租户、未完成、差评、无反馈、注入、评测原题、重复都不进训练集，并分别计数', async () => {
  const a = employee('e01');
  const g = employee('g01', 'globex');
  const { records, exportOptions } = await makeLog([
    { user: a, question: '差旅住宿报销上限是多少？' },
    { user: a, question: '差旅住宿报销上限是多少？' },
    { user: g, question: '差旅住宿报销上限是多少？' },
    { user: a, question: '婚假有几天？', rating: 'down' },
    { user: a, question: '加班以后怎么调休？', rating: null },
    { user: a, question: '会议室怎么预订？' },
    { user: a, question: evalCases[0].question },
  ]);
  const store = new Store(':memory:');
  const pending = store.createRun(a, 'VPN 连不上，帮我提交 IT 工单');
  await runAgent(pending.id, a, { model: createMockModel(), store, tools: createTools(store) });
  const unfinished = loadRuns(store);
  store.close();

  const { train, report } = exportSft([...records, ...unfinished], {
    ...exportOptions,
    feedback: [...exportOptions.feedback, { runId: pending.id, rating: 'up', source: 'human' }],
    optOutTenants: ['globex'],
    evalQuestions: evalCases.map((c) => c.question),
    valFraction: 0,
  });
  assert.equal(train.length, 1);
  assert.deepEqual(report.dropped, {
    duplicate: 1, tenant_opt_out: 1, negative_feedback: 1, no_positive_feedback: 1, injection: 1, eval_contamination: 1, not_completed: 1,
  });
  assert.ok(!JSON.stringify(train).includes('Globex'));
});

test('按员工划分训练集和验证集：同一员工的数据只在一侧，加入新数据后老员工不换边', async () => {
  const users = Array.from({ length: 20 }, (_, i) => employee(`u${i}`));
  const sessions = users.flatMap((user, i) => [
    { user, question: `去城市${i}出差，差旅住宿报销上限是多少？` },
    { user, question: `VPN 连不上，错误码 ${100 + i}，帮我提交 IT 工单` },
  ]);
  const { records, exportOptions } = await makeLog(sessions);
  const options = { ...exportOptions, valFraction: 0.3 };
  const { train, validation, report } = exportSft(records, options);
  assert.ok(train.length > 0 && validation.length > 0);
  assert.deepEqual(report.leakedUsers, []);
  assert.equal(report.train.users + report.validation.users, 20);
  assert.equal(train.length + validation.length, 40);

  const questionsOf = (examples: SftExample[]) => new Set(examples.map((e) => e.messages.find((m) => m.role === 'user')!.content));
  const half = exportSft(records.slice(0, 20), options);
  for (const question of questionsOf(half.validation)) assert.ok(questionsOf(validation).has(question));
  for (const question of questionsOf(half.train)) assert.ok(questionsOf(train).has(question));
});

test('偏好数据：取分差足够的最好/最差候选；平局、相同回答、两个都差、提示词以 assistant 结尾的组被丢弃', () => {
  const prompt = [{ role: 'system' as const, content: '系统' }, { role: 'user' as const, content: '差旅住宿报销上限？联系我 13812345678' }];
  const good = '一线城市每晚 500 元 [acme-travel@v2]';
  const groups: PreferenceGroup[] = [
    { prompt, candidates: [{ content: '每晚 1000 元', score: 0, source: 'human' }, { content: good, score: 1, source: 'human' }, { content: '大概 500', score: 0.5, source: 'judge' }] },
    { prompt, candidates: [{ content: 'A', score: 1, source: 'judge' }, { content: 'B', score: 1, source: 'judge' }] },
    { prompt, candidates: [{ content: good, score: 1, source: 'judge' }, { content: ` ${good}`, score: 0, source: 'judge' }] },
    { prompt, candidates: [{ content: '差', score: 0, source: 'judge' }, { content: '更差', score: -2, source: 'judge' }] },
    { prompt: [...prompt, { role: 'assistant' as const, content: '已经答过了' }], candidates: [{ content: good, score: 1, source: 'judge' }, { content: 'x', score: 0, source: 'judge' }] },
    { prompt, candidates: [{ content: good, score: 1, source: 'judge' }] },
  ];
  const { pairs, dropped } = buildPreferencePairs(groups);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].chosen, good);
  assert.equal(pairs[0].rejected, '每晚 1000 元');
  assert.equal(pairs[0].margin, 1);
  assert.deepEqual(dropped, { tie_or_small_margin: 1, identical_responses: 1, chosen_below_bar: 1, bad_prompt: 1, single_candidate: 1 });

  const line = toOpenAIDpo(pairs[0], []);
  assert.ok(!JSON.stringify(line).includes('13812345678'));
  assert.equal(line.input.messages.at(-1)?.role, 'user');
  assert.deepEqual(line.preferred_output, [{ role: 'assistant', content: good }]);
  assert.deepEqual(line.non_preferred_output, [{ role: 'assistant', content: '每晚 1000 元' }]);
});

test('前后对比：总通过率上升，但逐条对比抓住了 critical 用例的退化，结论为不能替换', async () => {
  const result = await compareModels(evalCases, createMockVariant('base'), createMockVariant('tuned'));
  assert.ok(result.b.passRate > result.a.passRate);
  assert.deepEqual(result.regressed.sort(), ['no-evidence-refusal', 'role-acl-denied']);
  assert.deepEqual(result.criticalRegressions, ['role-acl-denied']);
  assert.equal(result.verdict, 'block');
  assert.ok(result.pValue > 0.05);
});

test('显著性：小样本即使全部改进也不显著；6 条以上一致改进才可能低于 0.05', () => {
  assert.equal(mcnemarExact(5, 0), 0.0625);
  assert.equal(mcnemarExact(6, 0), 0.03125);
  assert.equal(mcnemarExact(0, 0), 1);
  const passing = { status: 'completed', inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  const diff = (id: string, aPassed: boolean): CaseDiff => ({
    id, critical: false, change: aPassed ? 'both_pass' : 'fixed',
    a: { ...passing, id, critical: false, passed: aPassed, failures: aPassed ? [] : ['x'] },
    b: { ...passing, id, critical: false, passed: true, failures: [] },
  });
  const few = Array.from({ length: 10 }, (_, i) => diff(`c${i}`, i >= 5));
  assert.equal(summarize(few).verdict, 'inconclusive');
  const enough = Array.from({ length: 10 }, (_, i) => diff(`c${i}`, i >= 6));
  assert.equal(summarize(enough).verdict, 'better');
});
