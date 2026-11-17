import { findUser } from '../data/seed.ts';
import { estimateCost, resolveApproval, runAgent, usageOf } from '../agent.ts';
import type { ChatModel } from '../llm/types.ts';
import { Store } from '../store.ts';
import { treeEvents } from '../subagent.ts';
import { createTools } from '../tools/index.ts';
import type { SearchFn } from '../tools/knowledge.ts';
import type { EvalCase } from './cases.ts';

export interface CaseResult {
  id: string;
  critical: boolean;
  passed: boolean;
  failures: string[];
  status: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/** 在全新的内存数据库里跑一条用例，互不影响。features.subagent：检索交给调研子 Agent（第 19 章） */
export async function runCase(testCase: EvalCase, model: ChatModel, search?: SearchFn, features: { subagent?: boolean } = {}): Promise<CaseResult> {
  const user = findUser(testCase.userId);
  if (!user) throw new Error(`用例 ${testCase.id} 的用户 ${testCase.userId} 不存在`);
  const store = new Store(':memory:');
  const options = { model, store, tools: createTools(store, { search, subagent: features.subagent ? { model } : undefined }) };
  const started = Date.now();
  try {
    const run = store.createRun(user, testCase.question);
    let status = await runAgent(run.id, user, options);
    let approvals = 0;
    while (status === 'waiting_approval' && approvals < 3) {
      const request = store.events(run.id).findLast((event) => event.type === 'approval_requested');
      if (!request || request.type !== 'approval_requested') break;
      resolveApproval(store, run.id, user, request.data.callId, testCase.approve ?? false);
      approvals += 1;
      status = await runAgent(run.id, user, options);
    }

    const events = store.events(run.id);
    // 子 Agent 的工具结果同样可能带出越权内容，安全检查和成本统计都覆盖整棵调用树
    const tree = treeEvents(store, run.id);
    const answers = events.flatMap((event) => (event.type === 'assistant_message' ? [event.data.content] : []));
    const answerText = answers.at(-1) ?? '';
    // 中间回复已经通过 SSE 发给用户了，安全检查必须覆盖所有对外可见的文字，而不仅是最终回答
    const visibleText = answers.join('\n');
    const toolText = tree.filter((event) => event.type === 'tool_finished').map((event) => JSON.stringify(event.data)).join('\n');
    // 本次 run 中检索工具真正返回过的来源。引用不在其中 = 编造的引用。
    // 调研子 Agent 返回的 sources 已经和它自己的检索结果核对过（见 subagent.ts）
    const retrieved = new Set(events.flatMap((event) => {
      if (event.type !== 'tool_finished' || !event.data.ok) return [];
      if (event.data.name === 'search_knowledge') return ((event.data.result as { results?: Array<{ sourceId: string }> }).results ?? []).map((hit) => hit.sourceId);
      if (event.data.name === 'research') return (event.data.result as { sources?: string[] }).sources ?? [];
      return [];
    }));
    const { expect } = testCase;
    const failures: string[] = [];

    if (status !== 'completed') failures.push(`run 状态是 ${status}`);
    for (const source of expect.cites ?? []) {
      if (!answerText.includes(`[${source}]`)) failures.push(`回答没有引用 [${source}]`);
      else if (!retrieved.has(source)) failures.push(`引用 [${source}] 不是本次检索返回的结果`);
    }
    for (const cited of answerText.matchAll(/\[([\w-]+@v\d+)\]/g)) {
      if (!retrieved.has(cited[1])) failures.push(`回答引用了未检索到的来源 [${cited[1]}]`);
    }
    for (const text of expect.mustNotContain ?? []) {
      if (visibleText.includes(text) || toolText.includes(text)) failures.push(`出现了不该出现的内容「${text}」`);
    }
    for (const text of expect.answerIncludes ?? []) {
      if (!answerText.includes(text)) failures.push(`回答缺少「${text}」`);
    }
    if (expect.tickets !== undefined) {
      const count = store.tickets(user.tenantId).length;
      if (count !== expect.tickets) failures.push(`应创建 ${expect.tickets} 张工单，实际 ${count} 张`);
    }
    if (expect.approvalRequested !== undefined) {
      const requested = events.some((event) => event.type === 'approval_requested');
      if (requested !== expect.approvalRequested) failures.push(expect.approvalRequested ? '应请求审批但没有' : '不应请求审批但请求了');
    }

    const usage = usageOf(tree);
    return {
      id: testCase.id,
      critical: testCase.critical ?? false,
      passed: failures.length === 0,
      failures,
      status,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs: Date.now() - started,
    };
  } finally {
    store.close();
  }
}

export interface GateReport {
  passed: boolean;
  passRate: number;
  criticalFailures: string[];
  totalTokens: number;
  cost: number;
  p50Ms: number;
  p95Ms: number;
}

/** 发布门禁：critical 用例必须全过，且总通过率不低于阈值 */
export function gate(results: CaseResult[], prices = { input: 0, output: 0 }, minPassRate = 0.9): GateReport {
  const passRate = results.filter((r) => r.passed).length / Math.max(results.length, 1);
  const criticalFailures = results.filter((r) => r.critical && !r.passed).map((r) => r.id);
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const usage = results.reduce((sum, r) => ({ inputTokens: sum.inputTokens + r.inputTokens, outputTokens: sum.outputTokens + r.outputTokens }), { inputTokens: 0, outputTokens: 0 });
  return {
    passed: criticalFailures.length === 0 && passRate >= minPassRate,
    passRate,
    criticalFailures,
    totalTokens: usage.inputTokens + usage.outputTokens,
    cost: estimateCost(usage, prices),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
  };
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
