// 第 23 章测试用的子进程：到约定时刻同时开始抢任务，抢到没有为止，输出抢到的 run id
import { RunQueue } from '../../src/distributed/queue.ts';
import { Store } from '../../src/store.ts';

const [dbPath, owner, startAt] = process.argv.slice(2);
const store = new Store(dbPath);
const queue = new RunQueue(store, { leaseMs: 60_000, tenantMaxInflight: 10_000 });
// 忙等而不是 setTimeout：让几个进程在同一毫秒内开抢，争抢才足够激烈
while (Date.now() < Number(startAt));
const claimed: string[] = [];
// 每领一个都让出一下事件循环，相当于真实 worker 领完去干活；否则一个进程连续拿写锁，别人只能干等
for (let lease = queue.claim(owner); lease; lease = queue.claim(owner)) {
  claimed.push(lease.runId);
  await new Promise((resolve) => setTimeout(resolve, 2));
}
store.close();
process.stdout.write(JSON.stringify(claimed));
