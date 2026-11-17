// 第 25 章：从运行日志导出微调数据。
// 先用离线 mock 模型模拟一段“线上运行日志”（多个员工、带个人信息、有赞有踩、有注入、有评测原题、有未完成的 run），
// 再导出 SFT 数据（OpenAI chat 微调格式）和 DPO 偏好数据，打印数据质量报告，写到 data/training/。
// 运行：npm run train:data。mock 模型不会学习，这里验证的是数据管线，不是训练效果。
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolveApproval, runAgent } from '../src/agent.ts';
import type { User } from '../src/data/seed.ts';
import { evalCases } from '../src/eval/cases.ts';
import { createMockModel } from '../src/llm/mock.ts';
import type { ChatModel } from '../src/llm/types.ts';
import { systemPrompt } from '../src/prompt.ts';
import { Store, type Run } from '../src/store.ts';
import { createTools } from '../src/tools/index.ts';
import { answerContext, buildPreferencePairs, citationScore, toOpenAIDpo, type PreferenceGroup } from '../src/training/preference.ts';
import { exportSft, governanceCheck, loadRuns, toJsonl, type Feedback } from '../src/training/sft.ts';
import { createMockVariant } from '../src/training/variants.ts';

const names = ['张伟', '王芳', '李娜', '刘洋', '陈静', '杨磊', '赵敏', '黄强', '周杰', '吴婷'];
const users: User[] = [
  ...names.map((name, i) => ({ id: `e${String(i + 1).padStart(2, '0')}`, name, tenantId: 'acme', roles: ['employee'] })),
  { id: 'f01', name: '孙丽', tenantId: 'acme', roles: ['employee', 'finance'] },
  { id: 'g01', name: '郑浩', tenantId: 'globex', roles: ['employee'] },
  { id: 'g02', name: '冯雪', tenantId: 'globex', roles: ['employee'] },
];
const cities = ['上海', '北京', '深圳', '成都', '杭州', '武汉', '西安', '南京', '广州', '重庆'];
const errors = ['809', '691', '720', '868', '412', '619', '651', '734', '789', '800'];

/** 每个员工的几次提问。approve：审批时的选择；undefined = 一直没处理，run 停在等待审批 */
function sessions(user: User, i: number): Array<{ question: string; approve?: boolean }> {
  const phone = `13${8 - (i % 3)}${String(10000000 + i * 7919).slice(0, 8)}`;
  const email = `${user.id}@${user.tenantId}.cn`;
  return [
    { question: `去${cities[i % cities.length]}出差，差旅住宿报销上限是多少？` },
    { question: `VPN 连不上，错误码 ${errors[i % errors.length]}，帮我提交 IT 工单。我的手机 ${phone}${i % 2 ? '' : `，邮箱 ${email}`}`, approve: i % 4 !== 3 },
    ...(i % 3 === 0 ? [{ question: '会议室怎么预订？' }] : []),
    ...(i % 4 === 1 ? [{ question: '出差住宿每晚能报销多少钱？' }] : []),
    ...(i % 5 === 2 ? [{ question: '食堂几点开饭？' }] : []),
    ...(i % 5 === 4 ? [{ question: '婚假有几天？请假期间联系人身份证 11010519900307123X' }] : []),
    ...(i === 6 ? [{ question: 'VPN 连不上，帮我提交 IT 工单' }] : []),
    ...(i === 7 ? [{ question: `去${cities[i % cities.length]}出差，差旅住宿报销上限是多少？` }] : []),
    ...(user.id === 'f01' ? [{ question: 'Q4 部门预算冻结了吗？' }] : []),
  ];
}

const store = new Store(':memory:');
const model = createMockModel();
const options = { model, store, tools: createTools(store) };
const feedback: Feedback[] = [];
let index = 0;
for (const user of users) {
  for (const { question, approve } of sessions(user, index)) {
    const run = store.createRun(user, question);
    let status = await runAgent(run.id, user, options);
    if (status === 'waiting_approval') {
      if (approve === undefined) continue;
      const request = store.events(run.id).findLast((event) => event.type === 'approval_requested');
      if (request?.type === 'approval_requested') resolveApproval(store, run.id, user, request.data.callId, approve);
      status = await runAgent(run.id, user, options);
    }
    const answer = store.events(run.id).findLast((event) => event.type === 'assistant_message');
    const text = answer?.type === 'assistant_message' ? answer.data.content : '';
    // 模拟的质量信号：员工常常给“无法确认”点踩，哪怕拒答是对的；引用了来源的回答由评审判通过；拒绝建单的不评价
    if (/无法给出确定答案|无法确认/.test(text)) feedback.push({ runId: run.id, rating: 'down', source: 'human' });
    else if (/工单已创建/.test(text)) feedback.push({ runId: run.id, rating: 'up', source: 'human' });
    else if (/\[[\w-]+@v\d+\]/.test(text)) feedback.push({ runId: run.id, rating: 'up', source: 'judge' });
  }
  index += 1;
}

const toolSpecs = options.tools.map((tool) => tool.spec);
const promptFor = (run: Run) => systemPrompt(users.find((u) => u.id === run.userId)!, new Date(run.createdAt));
const governance = { optOutTenants: ['globex'], evalQuestions: evalCases.map((c) => c.question) };
const knownNames = users.map((u) => u.name);
const records = loadRuns(store);
const sft = exportSft(records, { tools: toolSpecs, systemPrompt: promptFor, feedback, knownNames, splitSalt: '2026-11', ...governance });

// 偏好数据：同一个上下文，让 base / tuned 两个变体各答一遍，和日志里的回答一起用规则评审打分
const variants: ChatModel[] = [createMockVariant('base'), createMockVariant('tuned')];
const groups: PreferenceGroup[] = [];
for (const record of records) {
  if (governanceCheck(record, governance)) continue;
  const context = answerContext(record, promptFor(record.run));
  if (!context) continue;
  const candidates = [{ content: context.answer, score: citationScore(context.answer, context.retrieved), source: 'judge' as const }];
  for (const variant of variants) {
    const { message } = await variant.complete({ messages: context.prompt, tools: toolSpecs });
    if (!message.toolCalls?.length) candidates.push({ content: message.content, score: citationScore(message.content, context.retrieved), source: 'judge' });
  }
  groups.push({ prompt: context.prompt, candidates });
}
const preference = buildPreferencePairs(groups, { knownNames });
store.close();

mkdirSync('data/training', { recursive: true });
writeFileSync('data/training/sft.train.jsonl', toJsonl(sft.train));
writeFileSync('data/training/sft.validation.jsonl', toJsonl(sft.validation));
writeFileSync('data/training/dpo.jsonl', toJsonl(preference.pairs.map((pair) => toOpenAIDpo(pair, toolSpecs))));

const reasons: Record<string, string> = {
  tenant_opt_out: '租户退出训练', not_completed: '未完成', injection: '含注入内容', eval_contamination: '与评测题重复',
  negative_feedback: '差评', no_positive_feedback: '无正向信号', broken_tool_pairing: '工具配对损坏', pii_residual: '脱敏后仍有 PII',
  too_long: '超长', duplicate: '重复',
};
const { report } = sft;
console.log(`日志：${report.runs} 个 run，${users.length} 名员工，反馈 ${feedback.length} 条`);
console.log(`\nSFT 保留 ${report.kept} 条，过滤原因：`);
for (const [reason, count] of Object.entries(report.dropped)) console.log(`  ${reasons[reason] ?? reason}  ${count}`);
console.log(`脱敏：邮箱 ${report.redactions.email}　手机 ${report.redactions.phone}　身份证 ${report.redactions.idNumber}　长数字 ${report.redactions.longNumber}　姓名 ${report.redactions.name}`);
console.log(`划分（按员工）：训练 ${report.train.examples} 条 / ${report.train.users} 人　验证 ${report.validation.examples} 条 / ${report.validation.users} 人　两边都有的员工：${report.leakedUsers.length}`);
console.log(`估算 token：min ${report.tokens.min}　p50 ${report.tokens.p50}　p95 ${report.tokens.p95}　max ${report.tokens.max}　分布 ${JSON.stringify(report.tokens.histogram)}`);
console.log(`工具调用：${Object.entries(report.toolCalls).map(([name, n]) => `${name} ${n}`).join('　')}`);
console.log(`最终回答：带引用 ${report.answers.cited}　拒答 ${report.answers.refusal}　其他 ${report.answers.other}`);
if (report.answers.refusal === 0) console.log('⚠️ 训练集里没有一条拒答：照这份数据训练，模型会学会“不知道也硬答”（见 npm run train:compare）');

console.log(`\nDPO 候选组 ${groups.length} 个，得到 ${preference.pairs.length} 对，过滤：${JSON.stringify(preference.dropped)}`);
console.log(`chosen 比 rejected 长的比例：${(preference.chosenLongerRate * 100).toFixed(0)}%`);
const refusalPairs = preference.pairs.filter((pair) => /无法给出确定答案|无法确认/.test(pair.chosen)).length;
console.log(`其中 chosen 是拒答的：${refusalPairs} 对`);
console.log('\n已写入 data/training/sft.train.jsonl、sft.validation.jsonl、dpo.jsonl');
