import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chapterChecks } from '../src/verify/checks.ts';
import { runChecks, selectChapters, summarize, type ChapterChecks } from '../src/verify/runner.ts';

const node = process.execPath;
const options = { cwd: process.cwd(), baseEnv: { PATH: process.env.PATH ?? '' } };

test('验收：退出码非零、输出不符、超时都判为失败，跳过的检查不执行', async () => {
  const chapters: ChapterChecks[] = [
    {
      id: 'demo',
      title: 'demo',
      checks: [
        { name: 'ok', argv: [node, '-e', 'console.log("结论：✅ 可以发布")'], expect: /可以发布/ },
        { name: 'exit', argv: [node, '-e', 'console.log("boom"); process.exit(3)'] },
        { name: 'wording', argv: [node, '-e', 'console.log("结论：❌ 不能发布")'], expect: /可以发布/ },
        { name: 'hang', argv: [node, '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 500 },
        { name: 'env', argv: [node, '-e', 'process.exit(process.env.FLAG === "x" ? 0 : 1)'], env: { FLAG: 'x' } },
        { name: 'skipped', argv: [node, '-e', 'process.exit(1)'], skip: () => '未安装依赖' },
      ],
    },
  ];
  const results = await runChecks(chapters, options);
  const byName = Object.fromEntries(results.map((result) => [result.name, result]));
  assert.equal(byName.ok.status, 'pass');
  assert.equal(byName.exit.status, 'fail');
  assert.match(byName.exit.reason!, /退出码 3/);
  assert.match(byName.exit.output!, /boom/);
  assert.equal(byName.wording.status, 'fail');
  assert.equal(byName.hang.status, 'fail');
  assert.match(byName.hang.reason!, /超时/);
  assert.equal(byName.env.status, 'pass');
  assert.equal(byName.skipped.status, 'skip');
  assert.deepEqual(summarize(results), { pass: 2, fail: 3, skip: 1 });
});

test('验收：按章节 id 选择，未知 id 直接报错并列出可选项；每章至少一项检查且 id 唯一', () => {
  const all = chapterChecks();
  assert.deepEqual(selectChapters(all, ['red-team']).map((c) => c.id), ['red-team']);
  assert.throws(() => selectChapters(all, ['nope']), /未知章节：nope。可选：basics/);
  assert.equal(new Set(all.map((c) => c.id)).size, all.length);
  assert.ok(all.every((chapter) => chapter.checks.length > 0));
});
