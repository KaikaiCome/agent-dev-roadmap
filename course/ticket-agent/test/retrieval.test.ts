import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documents, findUser, type PolicyDocument } from '../src/data/seed.ts';
import { evalCases } from '../src/eval/cases.ts';
import { runCase } from '../src/eval/evaluate.ts';
import { createMockModel } from '../src/llm/mock.ts';
import { bm25 } from '../src/retrieval/bm25.ts';
import { chunkDocument } from '../src/retrieval/chunk.ts';
import { createMockEmbedder, createOpenAIEmbedder, type Embedder } from '../src/retrieval/embedding.ts';
import { createHybridRetriever } from '../src/retrieval/hybrid.ts';
import { searchDocuments, visibleDocuments } from '../src/tools/knowledge.ts';

const alice = findUser('alice')!;
const carol = findUser('carol')!;
const bob = findUser('bob')!;
const leave = documents.find((doc) => doc.id === 'acme-leave')!;
const retriever = () => createHybridRetriever({ docs: documents, embedder: createMockEmbedder() });

test('按句子切块：块不超过上限、相邻块重叠一句、引用仍是文档级', () => {
  const { chunks } = chunkDocument(leave, { size: 80, overlap: 1 });
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 80, chunk.text);
    assert.equal(chunk.sourceId, 'acme-leave@v1');
    assert.ok(chunk.indexText.startsWith('员工休假制度'), '检索文本带上文档标题');
  }
  for (let i = 1; i < chunks.length; i++) {
    const lastSentence = chunks[i - 1].text.match(/[^。]+。$/)![0];
    assert.ok(chunks[i].text.startsWith(lastSentence), `第 ${i} 块应以上一块的最后一句开头`);
  }
});

test('入库筛查：像指令的句子不进索引，并进入审核队列', () => {
  const meeting = documents.find((doc) => doc.id === 'acme-meeting')!;
  const { chunks, flagged } = chunkDocument(meeting);
  assert.equal(flagged.length, 1);
  assert.match(flagged[0], /忽略之前的所有规则/);
  assert.ok(chunks.every((chunk) => !chunk.text.includes('attacker')));
  assert.deepEqual(retriever().flagged.map((item) => item.sourceId), ['acme-meeting@v1']);
});

test('混合检索同样先过滤权限：越权文档即使语义相近也不会返回', async () => {
  const r = retriever();
  assert.deepEqual(await r.search(alice, 'Q4 部门预算冻结了吗'), []);
  assert.deepEqual((await r.search(carol, 'Q4 部门预算冻结了吗')).map((hit) => hit.sourceId), ['acme-budget@v1']);
  for (const user of [alice, carol, bob]) {
    const allowed = new Set(visibleDocuments(documents, user).map((doc) => `${doc.id}@v${doc.version}`));
    for (const query of ['出差住宿报销上限', '预算采购', '婚假有几天', 'VPN 连不上', '会议室预订']) {
      for (const hit of await r.search(user, query)) assert.ok(allowed.has(hit.sourceId), `${user.id} 不应看到 ${hit.sourceId}`);
    }
  }
});

test('BM25 的统计量只来自可见文档：其他租户的文档不影响打分', async () => {
  const globexOnly = documents.filter((doc) => doc.tenantId === 'globex');
  const extra: PolicyDocument[] = Array.from({ length: 20 }, (_, i) => ({
    id: `acme-extra-${i}`, tenantId: 'acme', title: '差旅附则', version: 1, status: 'active', allowedRoles: ['employee'], content: '住宿报销需要发票。',
  }));
  const scores = async (docs: PolicyDocument[]) => (await createHybridRetriever({ docs, embedder: createMockEmbedder(), mode: 'bm25' })
    .search(bob, '出差住宿报销上限')).map((hit) => hit.score);
  const isolated = await scores(globexOnly);
  assert.equal(isolated.length, 1);
  assert.deepEqual(await scores([...globexOnly, ...extra]), isolated);
  // 对照：如果在全库上算统计量，分数会随别人的文档变化
  const corpus = (docs: PolicyDocument[]) => docs.map((doc) => doc.content);
  assert.notEqual(bm25(corpus([...globexOnly, ...extra]), '住宿报销')[0].score, bm25(corpus(globexOnly), '住宿报销')[0].score);
});

test('换种说法也能召回，没有答案时仍然返回空', async () => {
  const r = retriever();
  assert.deepEqual(searchDocuments(documents, alice, '出差住酒店一晚能报多少钱'), [], '对照：关键词检索漏召');
  assert.deepEqual((await r.search(alice, '出差住酒店一晚能报多少钱')).map((hit) => hit.sourceId), ['acme-travel@v2']);
  const marriage = await r.search(alice, '结婚可以休息几天');
  assert.equal(marriage[0].sourceId, 'acme-leave@v1');
  assert.match(marriage[0].snippet, /婚假 3 天/, '片段来自答案所在的块');
  assert.deepEqual(await r.search(alice, '公司年会在哪里举办'), []);
  assert.deepEqual(await r.search(bob, '婚假有几天'), []);
});

test('同一文档的多个块只返回一次', async () => {
  const r = retriever();
  const query = '年假病假婚假调休怎么休';
  const leaveChunks = (await r.explain(alice, query)).filter((c) => c.chunk.sourceId === 'acme-leave@v1');
  assert.ok(leaveChunks.length > 1, '前提：同一文档有多个块被召回');
  const hits = await r.search(alice, query, 3);
  assert.equal(hits.filter((hit) => hit.sourceId === 'acme-leave@v1').length, 1);
});

test('重排序只看得到已授权的候选，并按它的分数重新排序', async () => {
  const seen: string[][] = [];
  const r = createHybridRetriever({
    docs: documents,
    embedder: createMockEmbedder(),
    minSimilarity: 0,
    minMatched: 1,
    rerank: async (_query, candidates) => {
      seen.push(candidates.map((c) => c.sourceId));
      return candidates.map((c) => (c.sourceId === 'acme-vpn@v1' ? 1 : 0));
    },
  });
  const hits = await r.search(alice, '出差住宿报销上限', 2);
  assert.equal(hits[0].sourceId, 'acme-vpn@v1');
  assert.ok(seen.flat().every((id) => id.startsWith('acme-') && id !== 'acme-budget@v1'));

  const broken = createHybridRetriever({ docs: documents, embedder: createMockEmbedder(), rerank: async () => [1], minSimilarity: 0, minMatched: 1 });
  await assert.rejects(broken.search(alice, '出差住宿报销上限'), /数量/);
});

test('块向量只计算一次，之后的查询只为问题本身计算向量', async () => {
  const mock = createMockEmbedder();
  const sizes: number[] = [];
  const counting: Embedder = { name: 'counting', embed: (texts) => { sizes.push(texts.length); return mock.embed(texts); } };
  const r = createHybridRetriever({ docs: documents, embedder: counting });
  await r.search(alice, '婚假有几天');
  await r.search(alice, '会议室怎么预订');
  assert.ok(sizes[0] > 1);
  assert.equal(sizes[1], 1);
});

test('OpenAI 兼容 embedding：分批请求，并按 index 排回输入顺序', async () => {
  const bodies: Array<{ model: string; input: string[] }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const data = body.input.map((text: string, index: number) => ({ index, embedding: [text.length] })).reverse();
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  const embedder = createOpenAIEmbedder({ baseURL: 'http://x', apiKey: 'k', model: 'm', batchSize: 2, fetchImpl });
  assert.deepEqual(await embedder.embed(['a', 'bb', 'ccc']), [[1], [2], [3]]);
  assert.deepEqual(bodies.map((body) => body.input), [['a', 'bb'], ['ccc']]);

  const failing = createOpenAIEmbedder({ baseURL: 'http://x', apiKey: 'k', model: 'm', fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch });
  await assert.rejects(failing.embed(['a']), /401/);
});

test('Agent 换用混合检索后，全部评测用例（含 critical）仍然通过', async () => {
  const r = retriever();
  const model = createMockModel();
  for (const testCase of evalCases) {
    const result = await runCase(testCase, model, (user, query, signal) => r.search(user, query, 3, signal));
    assert.ok(result.passed, `${testCase.id}: ${result.failures.join('; ')}`);
  }
});
