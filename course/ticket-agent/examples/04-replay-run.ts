// 第 17 章：排查线上问题的第一步——把一次 run 的完整现场取出来。
// 运行：npm run replay -- <runId> [--brief]（runId 在服务日志、SSE 事件或工作台里都能看到）
// 默认输出每个事件的完整数据；--brief 只输出每个事件的前 80 个字符，用来快速浏览
import { toModelMessages } from '../src/agent.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';

const args = process.argv.slice(2);
const brief = args.includes('--brief');
const runId = args.find((arg) => !arg.startsWith('--'));
if (!runId) {
  console.error('用法：npm run replay -- <runId> [--brief]');
  process.exit(1);
}

const store = new Store(loadConfig().databasePath);
const run = store.getRun(runId);
if (!run) {
  console.error(`找不到 run ${runId}`);
  process.exit(1);
}

const events = store.events(runId);
console.log(`run ${runId}（${run.userId}@${run.tenantId}，${run.status}）：${events.length} 个事件`);
for (const event of events) {
  const data = JSON.stringify(event.data);
  console.log(event.seq, event.type, brief && data.length > 80 ? `${data.slice(0, 80)}…` : data);
}

// 模型在最后一步“看到”的对话。把它原样发给模型反复调用，就能判断问题是否稳定复现
console.log('\n--- 发给模型的消息 ---');
console.log(JSON.stringify(toModelMessages(events), null, 2));
store.close();
