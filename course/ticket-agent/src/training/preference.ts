import { createHash } from 'node:crypto';
import { toModelMessages } from '../agent.ts';
import type { Message, ToolSpec } from '../llm/types.ts';
import { containsPii, emptyStats, redact, type RedactionStats } from './redact.ts';
import { toWireMessages, type RunRecord, type WireMessage } from './sft.ts';

// 第 25 章：偏好数据（DPO）。同一个上下文下的两个回答，一个更好（chosen）、一个更差（rejected）。
// 来源：员工对两个候选的选择、人工审核的通过/驳回，或评审模型给多个采样打分后取最好和最差。
// SFT 教模型“该怎么做”，DPO 教模型“两种做法里哪个更好”，适合修正 SFT 后仍残留的具体毛病。

export interface Candidate {
  content: string;
  /** 分数越高越好。人工通过/驳回可以记成 1/0，评审打分直接用分数 */
  score: number;
  source: 'human' | 'judge';
}

/** 同一个上下文（到最终回答之前的全部消息）下的多个候选回答 */
export interface PreferenceGroup {
  prompt: Message[];
  candidates: Candidate[];
}

export interface PreferencePair {
  prompt: WireMessage[];
  chosen: string;
  rejected: string;
  margin: number;
}

export type PairDropReason = 'single_candidate' | 'tie_or_small_margin' | 'identical_responses' | 'empty_response' | 'chosen_below_bar' | 'bad_prompt' | 'pii_residual' | 'duplicate';

export interface PreferenceOptions {
  /** chosen 和 rejected 至少差多少分。差距太小的对，多半是评审噪声 */
  minMargin?: number;
  /** chosen 自己至少要多少分：“两个都很差、其中一个稍好”的对会把模型往差的方向推 */
  minChosenScore?: number;
  knownNames?: string[];
}

export interface PreferenceResult {
  pairs: PreferencePair[];
  dropped: Partial<Record<PairDropReason, number>>;
  redactions: RedactionStats;
  /** chosen 比 rejected 长的比例。接近 1 说明数据在教模型“越长越好”，而不是“越对越好” */
  chosenLongerRate: number;
}

export function buildPreferencePairs(groups: PreferenceGroup[], options: PreferenceOptions = {}): PreferenceResult {
  const { minMargin = 1, minChosenScore = 1, knownNames = [] } = options;
  const redactions = emptyStats();
  const dropped: Partial<Record<PairDropReason, number>> = {};
  const drop = (reason: PairDropReason) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
  const seen = new Set<string>();
  const pairs: PreferencePair[] = [];

  for (const group of groups) {
    const last = group.prompt.at(-1);
    if (!last || last.role === 'assistant' || !group.prompt.some((m) => m.role === 'user')) { drop('bad_prompt'); continue; }
    const candidates = group.candidates.filter((c) => c.content.trim());
    if (candidates.length < 2) { drop(candidates.length < group.candidates.length ? 'empty_response' : 'single_candidate'); continue; }
    const ranked = [...candidates].sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const worst = ranked.at(-1)!;
    if (best.score - worst.score < minMargin) { drop('tie_or_small_margin'); continue; }
    if (best.score < minChosenScore) { drop('chosen_below_bar'); continue; }
    if (normalize(best.content) === normalize(worst.content)) { drop('identical_responses'); continue; }

    const prompt = toWireMessages(group.prompt, redactions, knownNames);
    const pair: PreferencePair = {
      prompt,
      chosen: redact(best.content, redactions, knownNames),
      rejected: redact(worst.content, redactions, knownNames),
      margin: best.score - worst.score,
    };
    if (containsPii(JSON.stringify(pair), knownNames)) { drop('pii_residual'); continue; }
    const key = createHash('sha256').update(JSON.stringify([prompt.slice(1), pair.chosen, pair.rejected])).digest('hex');
    if (seen.has(key)) { drop('duplicate'); continue; }
    seen.add(key);
    pairs.push(pair);
  }

  const longer = pairs.filter((pair) => pair.chosen.length > pair.rejected.length).length;
  return { pairs, dropped, redactions, chosenLongerRate: pairs.length ? longer / pairs.length : 0 };
}

/** OpenAI 的 DPO 格式：input.messages + preferred_output / non_preferred_output，偏好的只能是最后一条 assistant 消息 */
export function toOpenAIDpo(pair: PreferencePair, tools: ToolSpec[]) {
  return {
    input: { messages: pair.prompt, tools: tools.map((spec) => ({ type: 'function', function: spec })) },
    preferred_output: [{ role: 'assistant', content: pair.chosen }],
    non_preferred_output: [{ role: 'assistant', content: pair.rejected }],
  };
}

/** 开源训练框架（例如 Hugging Face TRL）常用的对话式格式：prompt / chosen / rejected */
export function toPromptChosenRejected(pair: PreferencePair) {
  return {
    prompt: pair.prompt,
    chosen: [{ role: 'assistant', content: pair.chosen }],
    rejected: [{ role: 'assistant', content: pair.rejected }],
  };
}

/**
 * 从一次已完成的 run 里取出“最终回答之前的上下文”和最终回答，以及本次检索到的来源。
 * 拿同一个上下文让其他模型（或同一模型多次采样）再答一遍，打分后就得到一组候选。
 */
export function answerContext({ events }: RunRecord, systemPrompt: string): { prompt: Message[]; answer: string; retrieved: string[] } | undefined {
  const messages: Message[] = [{ role: 'system', content: systemPrompt }, ...toModelMessages(events)];
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || last.toolCalls?.length) return undefined;
  const retrieved = events.flatMap((event) => (event.type === 'tool_finished' && event.data.ok && event.data.name === 'search_knowledge'
    ? ((event.data.result as { results?: Array<{ sourceId: string }> }).results ?? []).map((hit) => hit.sourceId)
    : []));
  return { prompt: messages.slice(0, -1), answer: last.content, retrieved };
}

/** 规则评审：引用了本次检索到的来源 +1，引用了没检索到的来源 -2，检索为空时明确拒答 +1 */
export function citationScore(answer: string, retrieved: string[]): number {
  const cited = [...answer.matchAll(/\[([\w-]+@v\d+)\]/g)].map((m) => m[1]);
  if (retrieved.length === 0) return /无法/.test(answer) && cited.length === 0 ? 1 : 0;
  const fabricated = cited.filter((id) => !retrieved.includes(id)).length;
  const grounded = cited.some((id) => retrieved.includes(id)) ? 1 : 0;
  return grounded - 2 * fabricated;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, '');
}
