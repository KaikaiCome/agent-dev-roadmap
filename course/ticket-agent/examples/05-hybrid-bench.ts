// 第 18 章：混合检索基准。对比四种检索方式在同一标注集上的表现。
// 运行：npm run bench:hybrid（默认离线向量替身；设置 EMBEDDING_PROVIDER=openai 等变量后用真实 embedding 模型）
import { loadConfig } from '../src/config.ts';
import { documents, findUser } from '../src/data/seed.ts';
import { createEmbedder } from '../src/retrieval/index.ts';
import { createHybridRetriever } from '../src/retrieval/hybrid.ts';
import { searchDocuments, visibleDocuments, type SearchHit } from '../src/tools/knowledge.ts';

interface Labeled {
  user: string;
  query: string;
  /** 应该命中的文档；null 表示知识库里没有该员工能看的答案，正确行为是返回空 */
  relevant: string | null;
  /** 返回的片段里必须包含的答案文字：文档命中了但片段没截到答案，模型照样答不出 */
  answer?: string;
}

const labeled: Labeled[] = [
  { user: 'alice', query: '差旅住宿报销上限是多少', relevant: 'acme-travel@v2', answer: '500 元' },
  { user: 'alice', query: 'VPN 连不上怎么办', relevant: 'acme-vpn@v1', answer: '重启客户端' },
  { user: 'carol', query: 'Q4 预算还能采购吗', relevant: 'acme-budget@v1', answer: '财务总监审批' },
  { user: 'alice', query: '会议室怎么预订', relevant: 'acme-meeting@v1', answer: '提前一天' },
  { user: 'bob', query: '出差住宿每晚能报销多少', relevant: 'globex-travel@v1', answer: '800 元' },
  { user: 'alice', query: '婚假有几天', relevant: 'acme-leave@v1', answer: '婚假 3 天' },
  { user: 'alice', query: '加班以后怎么调休', relevant: 'acme-leave@v1', answer: '直属主管审批' },
  // 换了说法：和原文几乎没有相同的词
  { user: 'alice', query: '出差住酒店一晚能报多少钱', relevant: 'acme-travel@v2', answer: '500 元' },
  { user: 'alice', query: '远程办公网络连不上', relevant: 'acme-vpn@v1', answer: '重启客户端' },
  { user: 'alice', query: '结婚可以休息几天', relevant: 'acme-leave@v1', answer: '婚假 3 天' },
  { user: 'alice', query: '生病了工资照发吗', relevant: 'acme-leave@v1', answer: '全额发放' },
  // 离线向量替身的词表没有覆盖“在家”“登录”，这条会漏召——提醒你替身的分数不代表真实模型
  { user: 'alice', query: '在家怎么登录公司系统', relevant: 'acme-vpn@v1', answer: '重启客户端' },
  // 没有答案：知识库里没有，或者有但该员工无权查看
  { user: 'alice', query: '公司年会在哪里举办', relevant: null },
  { user: 'alice', query: 'Q4 部门预算冻结了吗', relevant: null },
  { user: 'bob', query: '婚假有几天', relevant: null },
  { user: 'alice', query: '食堂几点开饭', relevant: null },
];

type Search = (userId: string, query: string) => Promise<SearchHit[]>;
const config = loadConfig();
const embedder = createEmbedder(config.embedding);
const hybrid = (mode: 'hybrid' | 'bm25' | 'vector') => {
  const retriever = createHybridRetriever({ docs: documents, embedder, mode, minSimilarity: config.embedding.minSimilarity });
  return (userId: string, query: string) => retriever.search(findUser(userId)!, query, 3);
};
const methods: Array<[string, Search]> = [
  ['关键词（第 3 章）', async (userId, query) => searchDocuments(documents, findUser(userId)!, query, 3)],
  ['BM25 + 切块', hybrid('bm25')],
  ['向量 + 切块', hybrid('vector')],
  ['混合（RRF）', hybrid('hybrid')],
];

const k = 3;
const answerable = labeled.filter((item) => item.relevant);
const unanswerable = labeled.filter((item) => !item.relevant);
console.log(`向量模型：${embedder.name}　标注 ${labeled.length} 条（有答案 ${answerable.length}，无答案 ${unanswerable.length}）\n`);
console.log('方法'.padEnd(14), `recall@${k}`, '  MRR ', '片段含答案', '正确拒答', '越权');

const details: string[] = [];
for (const [name, search] of methods) {
  let hits = 0, reciprocal = 0, answered = 0, refused = 0, leaked = 0;
  for (const item of labeled) {
    const results = await search(item.user, item.query);
    const allowed = new Set(visibleDocuments(documents, findUser(item.user)!).map((doc) => `${doc.id}@v${doc.version}`));
    leaked += results.filter((hit) => !allowed.has(hit.sourceId)).length;
    if (!item.relevant) {
      if (results.length === 0) refused++;
      if (name.startsWith('混合')) details.push(`${results.length === 0 ? '拒答' : '误召'}  ${item.query}  ${JSON.stringify(results.map((r) => r.sourceId))}`);
      continue;
    }
    const rank = results.findIndex((hit) => hit.sourceId === item.relevant);
    if (rank >= 0) {
      hits++;
      reciprocal += 1 / (rank + 1);
      if (item.answer && results[rank].snippet.includes(item.answer)) answered++;
    }
    if (name.startsWith('混合')) details.push(`${rank >= 0 ? '命中' : '漏召'}  ${item.query}  ${JSON.stringify(results.map((r) => r.sourceId))}`);
  }
  const n = answerable.length;
  console.log(name.padEnd(14), (hits / n).toFixed(2).padStart(8), (reciprocal / n).toFixed(2).padStart(6),
    (answered / n).toFixed(2).padStart(9), (refused / unanswerable.length).toFixed(2).padStart(8), String(leaked).padStart(4));
}
console.log('\n混合检索逐条结果：');
details.forEach((line) => console.log(line));
