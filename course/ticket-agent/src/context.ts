import type { Message } from './llm/types.ts';

/** 被清除的工具结果替换成这段话。保留消息本身，tool_call 和 tool 结果的配对才不会被破坏 */
export const CLEARED_RESULT = JSON.stringify({
  ok: true,
  cleared: true,
  note: '这次工具结果已从上下文中移除以节省空间；如果仍然需要，请重新调用工具。',
});

/**
 * 粗略估算 token：中日韩文字约 1 字 1 token，其余约 4 个字符 1 token。
 * 这是经验值，不是上限：不同模型的分词器差别很大，JSON、代码、数字往往比估算的多。
 * 所以预算要比模型窗口小得多（留出余量），准确数字以服务商返回的用量为准。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0)! >= 0x2e80) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function messageTokens(message: Message): number {
  const calls = message.role === 'assistant' ? message.toolCalls ?? [] : [];
  // 每条消息有角色、分隔符等固定开销
  return 4 + estimateTokens(message.content) + calls.reduce((sum, call) => sum + estimateTokens(call.name + call.arguments), 0);
}

export interface ContextOptions {
  /** 发给模型的上下文最多多少 token（不含输出） */
  budget: number;
  /** 消息以外、同样占用上下文的内容，例如工具定义 */
  overheadTokens?: number;
  /** 之前已经清除过的工具调用。它们继续保持清除，视图前缀才稳定 */
  alreadyCleared?: ReadonlySet<string>;
  /** 最近几条工具结果永远保留原文，模型通常正需要它们 */
  keepRecent?: number;
  /** 一旦超出预算，就清理到预算的这个比例以下，之后几轮不用再动前缀，提示词缓存才能命中 */
  target?: number;
}

export interface FittedContext {
  messages: Message[];
  tokens: number;
  /** 本次新清除的工具调用 id，调用方应记录下来，下一轮作为 alreadyCleared 传入 */
  newlyCleared: string[];
  fits: boolean;
}

/**
 * 让对话历史放进上下文预算：
 * 1. 之前清除过的结果继续清除（滞后：视图只在再次超出预算时才变化）；
 * 2. 仍超出预算时，从最旧的工具结果开始替换为占位说明，直到降到 budget × target 以下。
 * 系统提示词、用户问题、模型回复和最近的工具结果不动。
 * 只改发给模型的视图，事件日志里永远是完整记录，审计和回放不受影响。
 */
export function fitContext(messages: Message[], options: ContextOptions): FittedContext {
  const { budget, overheadTokens = 0, alreadyCleared = new Set<string>(), keepRecent = 2, target = 0.7 } = options;
  const result = messages.map((message) =>
    message.role === 'tool' && alreadyCleared.has(message.toolCallId) ? { ...message, content: CLEARED_RESULT } : message);
  let tokens = overheadTokens + result.reduce((sum, message) => sum + messageTokens(message), 0);
  const newlyCleared: string[] = [];
  if (tokens > budget) {
    const toolIndexes = result.flatMap((message, index) => (message.role === 'tool' ? [index] : []));
    const clearable = toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent));
    for (const index of clearable) {
      if (tokens <= budget * target) break;
      const message = result[index];
      if (message.role !== 'tool' || message.content === CLEARED_RESULT) continue;
      const replaced: Message = { ...message, content: CLEARED_RESULT };
      tokens += messageTokens(replaced) - messageTokens(message);
      result[index] = replaced;
      newlyCleared.push(message.toolCallId);
    }
  }
  return { messages: result, tokens, newlyCleared, fits: tokens <= budget };
}
