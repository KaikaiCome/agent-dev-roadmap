// 第 20 章：编码 Agent 离线演示。把 examples/fixtures/buggy-calc 复制到临时目录，
// 由照剧本行动的假模型“跑测试 → 读代码 → 改代码 → 再跑测试”，直到测试全部通过。仓库里的 fixture 不会被修改。
// 运行：npm run coding                  自动模式（一次性副本上不需要确认）
//       npm run coding -- --ask         每次改文件、跑命令前在终端确认
//       npm run coding -- --docker      在 Docker 容器里跑命令（需要本机有 Docker 和 node:24-slim 镜像）
import { createInterface } from 'node:readline/promises';
import { usageOf } from '../src/agent.ts';
import { runCodingTask } from '../src/coding/demo.ts';
import type { AgentEvent } from '../src/events.ts';

const ask = process.argv.includes('--ask');
const docker = process.argv.includes('--docker');
const prompt = ask ? createInterface({ input: process.stdin }) : undefined;
// 用迭代器逐行读取：输入既可以来自键盘，也可以是管道（echo y | npm run coding -- --ask）
const answers = prompt?.[Symbol.asyncIterator]();

console.log(`审批：${ask ? 'ask（每次副作用都确认）' : 'auto（一次性副本，不确认）'}　沙箱：${docker ? 'Docker 容器' : 'Node 权限模型'}`);

const { status, events, workspace, dispose } = await runCodingTask({
  approval: ask ? 'ask' : 'auto',
  runner: docker ? 'docker' : 'node-permission',
  approve: async (request) => {
    process.stdout.write(`\n需要你确认：\n${request.summary}\n确认执行？(y/N) `);
    const answer = String((await answers!.next()).value ?? '').trim().toLowerCase();
    if (!process.stdin.isTTY) console.log(answer);
    return answer === 'y';
  },
});
prompt?.close();

let step = 0;
try {
  for (const event of events) printEvent(event);
  const usage = usageOf(events);
  const inputs = events.flatMap((e) => (e.type === 'usage' ? [e.data.inputTokens] : []));
  console.log(`\n结果：${status}，模型调用 ${usage.modelCalls} 次`);
  console.log(`token（mock 按字符估算，不含工具说明）：输入 ${usage.inputTokens}，输出 ${usage.outputTokens}；每次调用的输入 ${inputs.join(' → ')}`);
  console.log(`工作区副本：${workspace}（演示结束后删除）`);
} finally {
  await dispose();
}

function printEvent(event: AgentEvent) {
  if (event.type === 'assistant_message') {
    step += 1;
    console.log(`\n[${step}] 模型：${event.data.content}`);
  }
  if (event.type === 'tool_started') {
    const args = event.data.args as Record<string, unknown>;
    console.log(`  → ${event.data.name} ${event.data.name === 'run_command' ? args.command : JSON.stringify(args)}`);
  }
  if (event.type !== 'tool_finished') return;
  if (!event.data.ok) {
    console.log(`  ✗ ${event.data.error?.code}：${event.data.error?.message}`);
    return;
  }
  const result = event.data.result as Record<string, unknown>;
  if (event.data.name === 'run_command') {
    const summary = String(result.output).split('\n').filter((line) => /^(✖|✔) |^ℹ (pass|fail) /.test(line) && !line.includes('failing tests'));
    console.log(`  ← exitCode ${result.exitCode}，${result.durationMs}ms\n${[...new Set(summary)].map((line) => `     ${line.replace(/ \([\d.]+ms\)$/, '')}`).join('\n')}`);
  } else if (event.data.name === 'list_files') {
    console.log(`  ← ${(result.files as Array<{ path: string }>).map((f) => f.path).join('、')}`);
  } else if (event.data.name === 'read_file') {
    console.log(`  ← ${result.path} 第 ${result.startLine}-${result.endLine} 行（共 ${result.totalLines} 行）`);
  } else {
    console.log(`  ← ${JSON.stringify(result)}`);
  }
}
