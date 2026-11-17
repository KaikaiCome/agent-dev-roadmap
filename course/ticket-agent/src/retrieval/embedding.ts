import { tokenize } from './text.ts';

/** 把一批文本变成向量。顺序与输入一致 */
export interface Embedder {
  name: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// 离线替身用的“概念词表”：同一行里的说法会被映射到同一个维度。
// 真实 embedding 模型从海量语料中学到“出差≈差旅、酒店≈住宿”，这里用手写词表模仿这种效果，
// 所以它只覆盖演示数据涉及的领域，词表之外的换种说法照样会漏召。它的分数不能代表真实模型的效果。
const concepts: string[][] = [
  ['差旅', '出差', '出行'],
  ['住宿', '酒店', '宾馆', '住一晚', '住哪'],
  ['报销', '报账', '能报', '补贴'],
  ['上限', '多少钱', '标准', '额度'],
  ['vpn', '网络', '内网', '连不上', '无法连接', '远程'],
  ['预算', '采购', '经费'],
  ['会议室', '开会'],
  ['休假', '请假', '年假', '假期', '放假', '休息'],
  ['婚假', '结婚'],
  ['病假', '生病', '看病'],
];

/** 离线向量：概念维度 + 哈希后的词维度。确定性、免费、不联网，适合测试和学习流程 */
export function createMockEmbedder(hashDims = 64): Embedder {
  return {
    name: 'mock-embedding',
    async embed(texts) {
      return texts.map((text) => {
        const lower = text.toLowerCase();
        const conceptPart = concepts.map((terms) => (terms.some((term) => lower.includes(term)) ? 1 : 0));
        const hashPart = new Array<number>(hashDims).fill(0);
        for (const token of tokenize(text)) hashPart[fnv1a(token) % hashDims] += 1;
        // 词维度整体缩放到固定长度 0.3：只在概念相同时区分细节，不会因为文本长而淹没概念维度
        const norm = Math.hypot(...hashPart) || 1;
        return [...conceptPart, ...hashPart.map((value) => (value / norm) * 0.3)];
      });
    },
  };
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

export interface OpenAIEmbedderOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 每次请求最多多少条文本，超过就分批 */
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

/** 兼容 OpenAI /embeddings 接口的服务（OpenAI、通义千问、智谱、本地 Ollama 等） */
export function createOpenAIEmbedder(options: OpenAIEmbedderOptions): Embedder {
  const fetchImpl = options.fetchImpl ?? fetch;
  const batchSize = options.batchSize ?? 64;
  return {
    name: options.model,
    async embed(texts, signal) {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const input = texts.slice(start, start + batchSize);
        const timeout = AbortSignal.timeout(30_000);
        const response = await fetchImpl(`${options.baseURL}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ model: options.model, input }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) throw new Error(`embedding 请求失败（${response.status}）`);
        const body = await response.json() as { data: Array<{ index: number; embedding: number[] }> };
        // 规范不保证返回顺序与输入一致，按 index 排回去
        const sorted = [...body.data].sort((a, b) => a.index - b.index);
        if (sorted.length !== input.length) throw new Error(`embedding 数量不匹配：发送 ${input.length} 条，返回 ${sorted.length} 条`);
        vectors.push(...sorted.map((item) => item.embedding));
      }
      return vectors;
    },
  };
}
