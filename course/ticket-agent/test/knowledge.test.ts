import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documents, findUser } from '../src/data/seed.ts';
import { searchDocuments } from '../src/tools/knowledge.ts';

const alice = findUser('alice')!;
const carol = findUser('carol')!;
const bob = findUser('bob')!;

test('只返回当前租户、当前生效版本的文档', () => {
  const hits = searchDocuments(documents, alice, '出差住宿报销上限');
  assert.deepEqual(hits.map((h) => h.sourceId), ['acme-travel@v2']);
  const globex = searchDocuments(documents, bob, '出差住宿报销上限');
  assert.deepEqual(globex.map((h) => h.sourceId), ['globex-travel@v1']);
});

test('没有角色权限的文档在检索阶段就被过滤，不会进入模型上下文', () => {
  assert.deepEqual(searchDocuments(documents, alice, 'Q4 部门预算冻结了吗'), []);
  assert.deepEqual(searchDocuments(documents, carol, 'Q4 部门预算冻结了吗').map((h) => h.sourceId), ['acme-budget@v1']);
});

test('没有相关内容时返回空，而不是硬凑结果', () => {
  assert.deepEqual(searchDocuments(documents, alice, '公司年会在哪里举办'), []);
});
