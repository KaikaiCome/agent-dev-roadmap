// 第 17 章：给检索打分。先量出 recall@k，才知道换算法有没有用。
// 运行：npm run bench
import { documents, findUser } from '../src/data/seed.ts';
import { searchDocuments } from '../src/tools/knowledge.ts';

// 标注集：问题 → 应该命中的文档。真实项目从线上日志抽样，由懂业务的人标注
const labeled = [
  { user: 'alice', query: '差旅住宿报销上限是多少', relevant: 'acme-travel@v2' },
  { user: 'alice', query: 'VPN 连不上怎么办', relevant: 'acme-vpn@v1' },
  { user: 'carol', query: 'Q4 预算还能采购吗', relevant: 'acme-budget@v1' },
  // 下面两条换了说法、和原文几乎没有相同的字，是关键词检索的典型盲区
  { user: 'alice', query: '出差住酒店一晚能报多少钱', relevant: 'acme-travel@v2' },
  { user: 'alice', query: '远程办公网络连不上', relevant: 'acme-vpn@v1' },
];

const k = 3;
let hits = 0;
for (const item of labeled) {
  const ids = searchDocuments(documents, findUser(item.user)!, item.query, k).map((hit) => hit.sourceId);
  const ok = ids.includes(item.relevant);
  if (ok) hits++;
  console.log(ok ? '命中' : '漏召', item.query, ids);
}
console.log(`recall@${k} = ${(hits / labeled.length).toFixed(2)}`);
