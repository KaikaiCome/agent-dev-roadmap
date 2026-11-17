import type { PolicyDocument, User } from '../data/seed.ts';
import { snippetAround, visibleDocuments, type SearchHit } from '../tools/knowledge.ts';
import { bm25 } from './bm25.ts';
import { chunkDocument, type Chunk, type ChunkOptions } from './chunk.ts';
import { cosine, type Embedder } from './embedding.ts';
import { tokenize } from './text.ts';

/** 重排序：对少量候选逐个精细打分（交叉编码器或 LLM），返回与 candidates 等长的分数，越大越相关 */
export type Reranker = (query: string, candidates: Array<{ sourceId: string; title: string; text: string }>, signal?: AbortSignal) => Promise<number[]>;

export interface HybridOptions {
  docs: PolicyDocument[];
  embedder: Embedder;
  chunk?: ChunkOptions;
  /** 只用一路时便于对比；默认两路融合 */
  mode?: 'hybrid' | 'bm25' | 'vector';
  /** 关键词一路的相关门槛：至少命中几个不同的词 */
  minMatched?: number;
  /** 向量一路的相关门槛。每换一个 embedding 模型都要用“无答案”用例重新校准 */
  minSimilarity?: number;
  /** RRF 常数，论文建议 60：越大，排名靠后的结果相对权重越高 */
  rrfK?: number;
  rerank?: Reranker;
  /** 送进重排序的候选数。重排序慢且贵，只对融合后的前几名做 */
  rerankDepth?: number;
}

export interface Candidate {
  chunk: Chunk;
  bm25Rank?: number;
  vectorRank?: number;
  similarity?: number;
  score: number;
}

export interface Retriever {
  search(user: User, query: string, limit?: number, signal?: AbortSignal): Promise<SearchHit[]>;
  /** 返回融合后、去重前的全部候选和各路排名，用于调参和排查漏召 */
  explain(user: User, query: string, signal?: AbortSignal): Promise<Candidate[]>;
  /** 入库筛查拦下的句子，交给人工审核 */
  flagged: Array<{ sourceId: string; sentence: string }>;
}

export function createHybridRetriever(options: HybridOptions): Retriever {
  const { embedder, mode = 'hybrid', minMatched = 2, minSimilarity = 0.5, rrfK = 60, rerankDepth = 10 } = options;
  // 文档版本不可变，所以块和向量都可以按 key 永久缓存；文档更新 = 新版本 = 新 key
  const chunked = options.docs.map((doc) => ({ doc, ...chunkDocument(doc, options.chunk) }));
  const chunks = chunked.flatMap((item) => item.chunks);
  const flagged = chunked.flatMap(({ doc, flagged }) => flagged.map((sentence) => ({ sourceId: `${doc.id}@v${doc.version}`, sentence })));
  const vectors = new Map<string, number[]>();

  async function explain(user: User, query: string, signal?: AbortSignal): Promise<Candidate[]> {
    // 第一步永远是权限过滤：两路检索、统计量、重排序都只能看到这些块
    const visible = new Set(visibleDocuments(options.docs, user));
    const pool = chunks.filter((chunk) => visible.has(chunk.doc));
    if (pool.length === 0) return [];

    const byKey = new Map<string, Candidate>();
    const candidate = (chunk: Chunk) => byKey.get(chunk.key) ?? byKey.set(chunk.key, { chunk, score: 0 }).get(chunk.key)!;

    if (mode !== 'vector') {
      bm25(pool.map((chunk) => chunk.indexText), query)
        .filter((result) => result.matched >= minMatched)
        .sort((a, b) => b.score - a.score)
        .forEach((result, rank) => { candidate(pool[result.index]).bm25Rank = rank + 1; });
    }

    if (mode !== 'bm25') {
      const missing = pool.filter((chunk) => !vectors.has(chunk.key));
      const embedded = await embedder.embed([query, ...missing.map((chunk) => chunk.indexText)], signal);
      missing.forEach((chunk, i) => vectors.set(chunk.key, embedded[i + 1]));
      pool
        .map((chunk) => ({ chunk, similarity: cosine(embedded[0], vectors.get(chunk.key)!) }))
        .filter((item) => item.similarity >= minSimilarity)
        .sort((a, b) => b.similarity - a.similarity)
        .forEach((item, rank) => Object.assign(candidate(item.chunk), { vectorRank: rank + 1, similarity: item.similarity }));
    }

    // RRF 只看名次不看分数：两路分数的量纲完全不同，不能直接相加
    for (const item of byKey.values()) {
      item.score = (item.bm25Rank ? 1 / (rrfK + item.bm25Rank) : 0) + (item.vectorRank ? 1 / (rrfK + item.vectorRank) : 0);
    }
    return [...byKey.values()].sort((a, b) => b.score - a.score);
  }

  return {
    explain,
    flagged,
    async search(user, query, limit = 3, signal) {
      // 同一文档的多个块只保留最好的一个：引用是文档级的，重复的块只会挤掉其他文档
      const seen = new Set<string>();
      let top = (await explain(user, query, signal)).filter((item) => !seen.has(item.chunk.sourceId) && seen.add(item.chunk.sourceId));
      if (options.rerank && top.length > 1) {
        top = top.slice(0, rerankDepth);
        const scores = await options.rerank(query, top.map(({ chunk }) => ({ sourceId: chunk.sourceId, title: chunk.doc.title, text: chunk.text })), signal);
        if (scores.length !== top.length) throw new Error('重排序返回的分数数量与候选不一致');
        top = top.map((item, i) => ({ ...item, score: scores[i] })).sort((a, b) => b.score - a.score);
      }
      const terms = new Set(tokenize(query));
      return top.slice(0, limit).map(({ chunk, score }) => ({
        sourceId: chunk.sourceId,
        title: chunk.doc.title,
        snippet: snippetAround(chunk.text, terms),
        score: Math.round(score * 10_000) / 10_000,
      }));
    },
  };
}
