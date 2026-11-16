import type { Config } from '../config.ts';
import { createMockModel } from './mock.ts';
import { createOpenAICompatibleModel } from './openai.ts';
import type { ChatModel } from './types.ts';

export function createModel(config: Config): ChatModel {
  if (config.provider === 'mock') return createMockModel({ delayMs: 15 });
  return createOpenAICompatibleModel({ baseURL: config.baseURL, apiKey: config.apiKey, model: config.model });
}
