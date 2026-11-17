import { documents } from '../data/seed.ts';
import type { ChatModel } from '../llm/types.ts';
import type { Memory } from '../memory.ts';
import type { Store } from '../store.ts';
import { subagentTool } from '../subagent.ts';
import { knowledgeTool, type SearchFn } from './knowledge.ts';
import { ticketTools } from './tickets.ts';
import type { Tool } from './types.ts';

export interface ToolOptions {
  /** 缺省为第 3 章的关键词检索 */
  search?: SearchFn;
  /** 第 19 章：给出 model 时，检索交给只读的调研子 Agent，父 Agent 不再直接持有 search_knowledge */
  subagent?: { model: ChatModel; maxSteps?: number; maxTokens?: number };
  /** 第 19 章：长期记忆，加入 remember 工具 */
  memory?: Memory;
}

/** 本 Agent 能使用的全部工具。新增工具只需要在这里注册 */
export function createTools(store: Store, options: ToolOptions = {}): Tool[] {
  const knowledge = knowledgeTool(documents, options.search);
  const retrieval = options.subagent ? subagentTool({ ...options.subagent, store, tools: [knowledge] }) : knowledge;
  return [retrieval, ...ticketTools(store), ...(options.memory ? [options.memory.tool] : [])];
}
