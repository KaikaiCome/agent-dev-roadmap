// 文件名用 -test.js 而不是 .test.js：node --test 默认会找到它，仓库根目录的 Vitest 不会把它当成自己的测试
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, average, subtract } from './calc.js';

test('add 两数相加', () => {
  assert.equal(add(2, 3), 5);
});

test('subtract 两数相减', () => {
  assert.equal(subtract(5, 3), 2);
});

test('average 求平均值', () => {
  assert.equal(average([1, 2, 3]), 2);
});

test('average 空数组返回 0', () => {
  assert.equal(average([]), 0);
});
