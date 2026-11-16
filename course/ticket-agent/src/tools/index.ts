import { documents } from '../data/seed.ts';
import type { Store } from '../store.ts';
import { knowledgeTool } from './knowledge.ts';
import { ticketTools } from './tickets.ts';
import type { Tool } from './types.ts';

/** 本 Agent 能使用的全部工具。新增工具只需要在这里注册 */
export function createTools(store: Store): Tool[] {
  return [knowledgeTool(documents), ...ticketTools(store)];
}
