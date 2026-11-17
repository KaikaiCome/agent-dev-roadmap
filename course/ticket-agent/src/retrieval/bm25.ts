import { tokenize } from './text.ts';

export interface Bm25Result {
  index: number;
  score: number;
  /** 命中了几个不同的查询词。原始分数随语料变化，用它做“是否相关”的门槛更稳定 */
  matched: number;
}

/**
 * BM25：词频有饱和（出现 10 次不比 3 次重要多少），罕见词权重高（IDF），长文档会被惩罚。
 * 统计量（文档数、平均长度、IDF）只在传进来的语料上计算——调用方先按权限过滤，
 * 别的租户的文档就不会影响打分，也无法通过分数变化推测它们的存在。
 */
export function bm25(corpus: string[], query: string, { k1 = 1.2, b = 0.75 } = {}): Bm25Result[] {
  const docs = corpus.map((text) => {
    const tf = new Map<string, number>();
    const tokens = tokenize(text);
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    return { tf, length: tokens.length };
  });
  const n = docs.length;
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(n, 1);
  const terms = [...new Set(tokenize(query))];
  const idf = new Map(terms.map((term) => {
    const df = docs.filter((doc) => doc.tf.has(term)).length;
    return [term, Math.log(1 + (n - df + 0.5) / (df + 0.5))];
  }));

  return docs.map((doc, index) => {
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const tf = doc.tf.get(term) ?? 0;
      if (tf === 0) continue;
      matched++;
      score += idf.get(term)! * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.length / avgLength));
    }
    return { index, score, matched };
  });
}
