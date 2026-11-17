import type { PolicyDocument } from '../data/seed.ts';

export interface Chunk {
  /** 文档 ID + 版本 + 块序号，例如 acme-leave@v1#2。用作向量缓存的键 */
  key: string;
  /** 引用仍然到文档级：acme-leave@v1 */
  sourceId: string;
  doc: PolicyDocument;
  index: number;
  /** 展示给模型的原文片段 */
  text: string;
  /** 参与检索的文本 = 文档标题 + 片段。块脱离了文档后，标题是它最重要的上下文 */
  indexText: string;
}

export interface ChunkOptions {
  /** 每块最多多少字。按句子打包，单句超长时整句成块 */
  size?: number;
  /** 相邻块重叠几句，避免答案正好被切在两块的边界上 */
  overlap?: number;
}

// 入库筛查：像是写给 AI 的指令的句子不进索引。
// 注入文档常故意堆砌热门词（“财务预算”），让自己被尽量多的问题召回；向量检索会放大这种效果。
// 规则很容易被绕过，它只是最便宜的一层，不能代替第 9 章的运行时防御（数据声明、审批、权限）。
const instructionPatterns = [
  /忽略(之前|以上|前面|上述)?的?(所有|全部)?(规则|指令|要求)/,
  /【\s*系统(指令|提示|消息)\s*】/,
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /(立即|马上)调用\s*[a-z_]+/i,
];

export function looksLikeInstruction(sentence: string): boolean {
  return instructionPatterns.some((pattern) => pattern.test(sentence));
}

export interface ChunkedDocument {
  chunks: Chunk[];
  /** 被筛掉的句子：进入人工审核队列，而不是悄悄丢弃 */
  flagged: string[];
}

/** 按句子切块：先切成句、筛掉可疑句，再把相邻句子打包到 size 以内，相邻块重叠 overlap 句 */
export function chunkDocument(doc: PolicyDocument, { size = 120, overlap = 1 }: ChunkOptions = {}): ChunkedDocument {
  const all = doc.content.match(/[^。！？；\n]+[。！？；\n]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const flagged = all.filter(looksLikeInstruction);
  const sentences = all.filter((sentence) => !looksLikeInstruction(sentence));
  const groups: string[][] = [];
  let current: string[] = [];
  for (const sentence of sentences) {
    if (current.length > 0 && current.join('').length + sentence.length > size) {
      groups.push(current);
      current = overlap > 0 ? current.slice(-overlap) : [];
      // 重叠句加上新句仍超长时放弃重叠，保证每块都在推进
      if (current.join('').length + sentence.length > size) current = [];
    }
    current.push(sentence);
  }
  if (current.length > 0) groups.push(current);

  const sourceId = `${doc.id}@v${doc.version}`;
  const chunks = groups.map((group, index) => {
    const text = group.join('');
    return { key: `${sourceId}#${index}`, sourceId, doc, index, text, indexText: `${doc.title}\n${text}` };
  });
  return { chunks, flagged };
}
