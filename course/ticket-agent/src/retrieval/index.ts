import type { Config } from '../config.ts';
import { documents } from '../data/seed.ts';
import type { SearchFn } from '../tools/knowledge.ts';
import { createMockEmbedder, createOpenAIEmbedder, type Embedder } from './embedding.ts';
import { createHybridRetriever } from './hybrid.ts';

export function createEmbedder(config: Config['embedding']): Embedder {
  return config.provider === 'openai'
    ? createOpenAIEmbedder({ baseURL: config.baseURL, apiKey: config.apiKey, model: config.model })
    : createMockEmbedder();
}

/** 按配置返回检索函数；keyword 返回 undefined，即沿用 knowledgeTool 的默认关键词检索 */
export function createSearch(config: Pick<Config, 'retrieval' | 'embedding'>): SearchFn | undefined {
  if (config.retrieval !== 'hybrid') return undefined;
  const retriever = createHybridRetriever({
    docs: documents, embedder: createEmbedder(config.embedding), minSimilarity: config.embedding.minSimilarity,
  });
  return (user, query, signal) => retriever.search(user, query, 3, signal);
}
