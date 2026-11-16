import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { resolveApproval, runAgent, usageOf } from './agent.ts';
import { loadConfig } from './config.ts';
import { findUser, users } from './data/seed.ts';
import { createModel } from './llm/index.ts';
import { Store } from './store.ts';
import { createTools } from './tools/index.ts';

// 命令行版 Agent：不需要前端，最快验证整条链路。用法：npm run chat -- --user alice
const { values } = parseArgs({ options: { user: { type: 'string', default: 'alice' } } });
const user = findUser(values.user!);
if (!user) {
  console.error(`未知用户 ${values.user}，可选：${users.map((u) => u.id).join(', ')}`);
  process.exit(1);
}

const config = loadConfig();
const store = new Store(':memory:');
const model = createModel(config);
const tools = createTools(store);
const rl = createInterface({ input: process.stdin, output: process.stdout });

store.onEvent((event) => {
  if (event.type === 'tool_started') console.log(`\n  → 调用工具 ${event.data.name} ${JSON.stringify(event.data.args)}`);
  if (event.type === 'tool_finished') {
    console.log(`  ← ${event.data.ok ? '成功' : `失败 ${event.data.error?.code}: ${event.data.error?.message}`}`);
  }
});

console.log(`模型：${model.name}　用户：${user.name}　输入 exit 退出`);
while (true) {
  const question = (await rl.question('\n你> ')).trim();
  if (!question) continue;
  if (question === 'exit') break;

  const run = store.createRun(user, question);
  process.stdout.write('Agent> ');
  let status = await runAgent(run.id, user, { model, store, tools, onDelta: (_, text) => process.stdout.write(text) });
  while (status === 'waiting_approval') {
    const request = store.events(run.id).findLast((event) => event.type === 'approval_requested');
    if (!request || request.type !== 'approval_requested') break;
    console.log(`\n\n需要你确认：\n${request.data.summary}`);
    const answer = (await rl.question('确认执行？(y/N) ')).trim().toLowerCase();
    resolveApproval(store, run.id, user, request.data.callId, answer === 'y');
    process.stdout.write('Agent> ');
    status = await runAgent(run.id, user, { model, store, tools, onDelta: (_, text) => process.stdout.write(text) });
  }
  const usage = usageOf(store.events(run.id));
  console.log(`\n[${status}] 模型调用 ${usage.modelCalls} 次，token ${usage.inputTokens}+${usage.outputTokens}`);
}
rl.close();
store.close();
