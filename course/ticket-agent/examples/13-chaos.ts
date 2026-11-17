// 第 23 章：混沌测试。启动多个 worker 子进程共享一个 SQLite 文件，执行期间随机 kill -9 或“冻住”其中一些，
// 结束后检查不变量：每个 run 都恰好完成一次、没有重复工单、没有丢失的 run、通知恰好生效一次。
//
//   npm run chaos                          默认：4 个 worker，200 个 run
//   npm run chaos -- --workers 6 --runs 500
//   npm run chaos -- --no-fencing          关掉栅栏令牌，看看会发生什么
import { fork, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveApproval } from '../src/agent.ts';
import { findUser, type User } from '../src/data/seed.ts';
import { terminalStatuses } from '../src/events.ts';
import { Inbox, Outbox, startDispatcher, withTicketOutbox } from '../src/distributed/outbox.ts';
import { RunQueue } from '../src/distributed/queue.ts';
import { agentExecutor, QueueWorker, uniqueCallIds, type WorkerEvent } from '../src/distributed/worker.ts';
import { createMockModel } from '../src/llm/mock.ts';
import type { ChatModel } from '../src/llm/types.ts';
import { Store } from '../src/store.ts';
import { createTools } from '../src/tools/index.ts';

const { values: args } = parseArgs({
  options: {
    workers: { type: 'string', default: '4' },
    runs: { type: 'string', default: '200' },
    'no-fencing': { type: 'boolean', default: false },
    worker: { type: 'boolean', default: false },
    seed: { type: 'string', default: '23' },
  },
});

const LEASE_MS = 600;
const TENANT_MAX_INFLIGHT = 4;
const MAX_ATTEMPTS = 8;
const fencing = !args['no-fencing'];
const dir = join(import.meta.dirname, '..', 'data', 'chaos');
const dbPath = join(dir, 'agent.db');
const inboxPath = join(dir, 'inbox.db');

if (args.worker) await workerMain();
else await main();

// ───────────────────────────── worker 子进程 ─────────────────────────────

async function workerMain() {
  const store = new Store(dbPath);
  const queue = new RunQueue(store, { leaseMs: LEASE_MS, fencing, tenantMaxInflight: TENANT_MAX_INFLIGHT, maxAttempts: MAX_ATTEMPTS });
  const outbox = new Outbox(store, { leaseMs: 1000 });
  const inbox = new Inbox(inboxPath);
  const model = uniqueCallIds(slowModel(createMockModel()));
  const tools = withTicketOutbox(createTools(store), outbox);
  const report = (event: WorkerEvent) => process.send?.({ type: event.type, attempt: event.lease.attempt });
  const worker = new QueueWorker({
    queue, execute: agentExecutor({ model, store, tools }), concurrency: 3, pollMs: 50, heartbeatMs: LEASE_MS / 4, onEvent: report,
  });
  // 通知服务偶尔失败（10%），失败的消息稍后重试；处理完到返回响应之间有一段延迟，进程在这期间被杀就会重复投递
  const dispatcher = startDispatcher(outbox, worker.owner, async (message) => {
    if (Math.random() < 0.1) throw new Error('notification service 503');
    inbox.receive(message);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }, { pollMs: 50 });
  worker.start();
  process.on('message', async (message: { type: string; ms?: number }) => {
    if (message.type === 'pause') {
      // 同步阻塞整个线程：模拟长时间 GC 停顿或进程被调度器挂起。期间心跳发不出去，租约会过期
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, message.ms);
    }
    if (message.type === 'stop') {
      await worker.stop();
      await dispatcher.stop();
      store.close();
      inbox.close();
      process.exit(0);
    }
  });
}

/** 每次模型调用随机耗时 20~80ms，让 run 执行得足够久，kill 和冻结才会落在执行中途 */
function slowModel(model: ChatModel): ChatModel {
  return {
    name: model.name,
    async complete(request) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 20 + Math.random() * 60);
        request.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(request.signal!.reason); }, { once: true });
      });
      return model.complete(request);
    },
  };
}

// ───────────────────────────── 主进程 ─────────────────────────────

async function main() {
  console.log('== 第一部分：为什么不能“写库然后调 API” ==\n');
  await dualWriteDemo(Number(args.seed));
  console.log(`\n== 第二部分：混沌测试（${fencing ? '栅栏令牌开启' : '栅栏令牌关闭！'}） ==\n`);
  await chaos();
}

/**
 * 1000 张工单，每张在“危险时刻”有 5% 的概率崩溃，崩溃后按恢复逻辑重新执行。
 * 对比三种写法下，通知服务里实际生效的通知数。
 */
async function dualWriteDemo(seed: number) {
  const random = mulberry32(seed);
  const total = 1000;
  const crashRate = 0.05;
  const crash = () => random() < crashRate;

  // A：先提交工单，再调通知 API。崩溃发生在两者之间时，重试发现工单已存在（幂等），不会再通知
  const a = { tickets: new Set<number>(), notified: new Map<number, number>() };
  for (let id = 0; id < total; id++) {
    let crashed = true;
    while (crashed) {
      crashed = false;
      const created = !a.tickets.has(id);
      a.tickets.add(id);
      if (crash()) { crashed = true; continue; }
      if (created) a.notified.set(id, (a.notified.get(id) ?? 0) + 1);
    }
  }

  // B：先调通知 API，再提交工单。崩溃发生在两者之间时，重试会再通知一次
  const b = { tickets: new Set<number>(), notified: new Map<number, number>() };
  for (let id = 0; id < total; id++) {
    let crashed = true;
    while (crashed) {
      crashed = false;
      if (b.tickets.has(id)) break;
      b.notified.set(id, (b.notified.get(id) ?? 0) + 1);
      if (crash()) { crashed = true; continue; }
      b.tickets.add(id);
    }
  }

  // C：工单和 outbox 消息同一个事务提交；dispatcher 投递后、确认前崩溃 → 租约过期后重投；消费端按 key 去重
  const store = new Store(':memory:');
  let now = 0;
  const outbox = new Outbox(store, { leaseMs: 1000, now: () => now });
  const inbox = new Inbox(':memory:');
  const run = store.createRun(findUser('alice')!, 'demo');
  for (let id = 0; id < total; id++) {
    store.transaction(() => outbox.add({ runId: run.id, topic: 'ticket.created', key: `ticket.created:${id}`, payload: { id } }));
  }
  for (let messages = outbox.claim('d', 50); messages.length > 0 || outbox.stats().pending > 0; messages = outbox.claim('d', 50)) {
    for (const message of messages) {
      inbox.receive(message);
      if (crash()) continue;
      outbox.ack(message, 'd');
    }
    now += 1001;
  }
  const effects = (notified: Map<number, number>) => {
    const counts = [...notified.values()];
    return { lost: total - counts.length, duplicated: counts.filter((n) => n > 1).length };
  };
  const inboxStats = inbox.stats();
  const rows = [
    ['A 先写库，再调通知 API', a.tickets.size, a.notified.size, effects(a.notified).lost, effects(a.notified).duplicated, '-'],
    ['B 先调通知 API，再写库', b.tickets.size, b.notified.size, effects(b.notified).lost, effects(b.notified).duplicated, '-'],
    ['C outbox + 消费端去重', total, inboxStats.applied, total - inboxStats.applied, 0, inboxStats.received],
  ];
  console.log(`每张工单在危险时刻有 ${crashRate * 100}% 概率崩溃，崩溃后重新执行（共 ${total} 张）`);
  console.log(`${pad('写法', 26)}${pad('工单', 6)}${pad('收到通知', 10)}${pad('丢失', 6)}${pad('重复', 6)}投递次数`);
  for (const [name, ...cells] of rows) console.log(pad(String(name), 26) + cells.map((cell, i) => pad(String(cell), i === 1 ? 10 : 6)).join(''));
  store.close();
  inbox.close();
}

async function chaos() {
  rmSync(dir, { recursive: true, force: true });
  const workerCount = Number(args.workers);
  const runCount = Number(args.runs);
  const random = mulberry32(Number(args.seed));
  const store = new Store(dbPath);
  const queue = new RunQueue(store, { leaseMs: LEASE_MS, fencing, tenantMaxInflight: TENANT_MAX_INFLIGHT, maxAttempts: MAX_ATTEMPTS, tenantMaxQueued: runCount });
  new Outbox(store);
  const inbox = new Inbox(inboxPath);

  const people = ['alice', 'carol', 'bob'].map((id) => findUser(id)!);
  const ticketRuns = new Set<string>();
  const runIds: string[] = [];
  store.transaction(() => {
    for (let i = 0; i < runCount; i++) {
      const user = people[i % people.length];
      const wantsTicket = i % 2 === 0;
      const submitted = queue.submit(user, wantsTicket ? `帮我提交工单：显示器坏了 #${i}` : `出差住宿标准是多少 #${i}`);
      if (!submitted.ok) throw new Error(submitted.message);
      runIds.push(submitted.run.id);
      if (wantsTicket) ticketRuns.add(submitted.run.id);
    }
  });

  const counters = { claimed: 0, reclaimed: 0, fenced: 0, errors: 0, kills: 0, pauses: 0, approvals: 0 };
  const workers = new Set<ChildProcess>();
  const spawn = () => {
    const child = fork(import.meta.filename, ['--worker', ...(fencing ? [] : ['--no-fencing'])], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    child.on('message', (message: { type: string; attempt: number }) => {
      if (message.type === 'claimed') {
        counters.claimed += 1;
        if (message.attempt > 1) counters.reclaimed += 1;
      }
      if (message.type === 'fenced') counters.fenced += 1;
      if (message.type === 'error') counters.errors += 1;
    });
    child.on('exit', () => workers.delete(child));
    workers.add(child);
  };
  for (let i = 0; i < workerCount; i++) spawn();

  const started = Date.now();
  let maxDepth = 0;
  let maxTenantInflight = 0;
  let nextChaos = started + 1000;
  const deadline = started + 120_000;
  const unfinished = () => runIds.filter((id) => !terminalStatuses.includes(store.getRun(id)!.status)).length;

  while (unfinished() > 0 && Date.now() < deadline) {
    await sleep(50);
    const stats = queue.stats();
    maxDepth = Math.max(maxDepth, stats.queued);
    maxTenantInflight = Math.max(maxTenantInflight, ...Object.values(stats.tenants).map((t) => t.inflight));
    // 扮演员工：确认所有挂起的工单
    for (const run of store.runsWithStatus('waiting_approval')) {
      if (queue.state(run.id)?.state !== 'parked') continue;
      const request = store.events(run.id).findLast((e) => e.type === 'approval_requested');
      if (request?.type !== 'approval_requested') continue;
      const user = findUser(run.userId) as User;
      if (queue.resumeAfter(run.id, () => resolveApproval(store, run.id, user, request.data.callId, true)).ok) counters.approvals += 1;
    }
    // 每 400ms 随机挑一个 worker：一半概率 kill -9（马上补一个新进程），一半概率冻住 2.5 个租约周期
    if (Date.now() >= nextChaos && workers.size > 0) {
      nextChaos = Date.now() + 400;
      const victim = [...workers][Math.floor(random() * workers.size)];
      if (random() < 0.5) {
        victim.kill('SIGKILL');
        workers.delete(victim);
        counters.kills += 1;
        spawn();
      } else {
        victim.send({ type: 'pause', ms: LEASE_MS * 2.5 });
        counters.pauses += 1;
      }
    }
  }
  const runSeconds = (Date.now() - started) / 1000;
  // 所有 run 结束后，等 outbox 投递完
  const outboxView = new Outbox(store);
  while (outboxView.stats().pending > 0 && Date.now() < deadline) await sleep(50);
  await Promise.all([...workers].map((child) => new Promise((resolve) => {
    child.once('exit', resolve);
    child.send({ type: 'stop' });
  })));

  // ── 检查不变量 ──
  const statuses = new Map<string, number>();
  for (const id of runIds) statuses.set(store.getRun(id)!.status, (statuses.get(store.getRun(id)!.status) ?? 0) + 1);
  const tickets = [...new Set(people.map((p) => p.tenantId))].flatMap((tenant) => store.tickets(tenant));
  const ticketsPerRun = new Map<string, number>();
  for (const ticket of tickets) {
    const runId = ticket.idempotencyKey.split(':')[0];
    ticketsPerRun.set(runId, (ticketsPerRun.get(runId) ?? 0) + 1);
  }
  const duplicateTickets = [...ticketsPerRun.values()].filter((n) => n > 1).length;
  const completedTicketRuns = [...ticketRuns].filter((id) => store.getRun(id)!.status === 'completed');
  const lostTickets = completedTicketRuns.filter((id) => !ticketsPerRun.has(id)).length;
  const badLogs = runIds.filter((id) => {
    const events = store.events(id);
    const finishes = events.filter((e) => e.type === 'run_finished').length;
    return finishes !== 1 || events.at(-1)?.type !== 'run_finished';
  }).length;
  const outboxStats = outboxView.stats();
  const inboxStats = inbox.stats();
  const dead = queue.deadLetters().length;

  console.log(`worker 进程 ${workerCount} 个（每个并发 3），租约 ${LEASE_MS}ms，每租户在途上限 ${TENANT_MAX_INFLIGHT}，run ${runCount} 个（一半要提交工单）`);
  console.log(`混沌：kill -9 ${counters.kills} 次，冻结 ${counters.pauses} 次（每次 ${LEASE_MS * 2.5}ms）\n`);
  console.log(`耗时 ${runSeconds.toFixed(1)} s，吞吐 ${(runCount / runSeconds).toFixed(1)} run/s`);
  console.log(`领取 ${counters.claimed} 次，其中接手别人过期租约 ${counters.reclaimed} 次；${fencing ? '栅栏拒绝僵尸写入' : '僵尸的队列操作被 owner 检查拒绝（run 表本身不设防）'} ${counters.fenced} 次；人工确认 ${counters.approvals} 次`);
  console.log(`队列最大积压 ${maxDepth}，单租户最大在途 ${maxTenantInflight}（上限 ${TENANT_MAX_INFLIGHT}）`);
  console.log(`outbox：已投递 ${outboxStats.delivered}，待投递 ${outboxStats.pending}，死信 ${outboxStats.dead}；通知服务收到 ${inboxStats.received} 次，生效 ${inboxStats.applied} 次\n`);

  const checks: Array<[string, boolean, string]> = [
    ['每个 run 都已结束（没有丢失或卡住的）', unfinished() === 0, `未结束 ${unfinished()}`],
    ['所有 run 都成功完成', statuses.get('completed') === runCount, [...statuses].map(([s, n]) => `${s} ${n}`).join('，')],
    ['死信为 0', dead === 0, `死信 ${dead}`],
    ['每个 run 的事件日志恰好一个 run_finished，且之后没有写入', badLogs === 0, `异常 ${badLogs} 个`],
    ['每个要工单的 run 恰好一张工单', duplicateTickets === 0 && lostTickets === 0 && tickets.length === completedTicketRuns.length,
      `工单 ${tickets.length} 张 / 应有 ${completedTicketRuns.length}，重复 ${duplicateTickets}，缺失 ${lostTickets}`],
    ['每张工单的通知恰好生效一次', inboxStats.applied === tickets.length && outboxStats.pending === 0,
      `生效 ${inboxStats.applied}，投递 ${inboxStats.received}（重复投递 ${inboxStats.received - inboxStats.applied} 次被去重）`],
    ['租户在途数从未超过上限', maxTenantInflight <= TENANT_MAX_INFLIGHT, `最大 ${maxTenantInflight}`],
  ];
  for (const [name, ok, detail] of checks) console.log(`${ok ? '✔' : '✘'} ${name}  —  ${detail}`);
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(failed === 0 ? '\n全部不变量成立' : `\n${failed} 条不变量被破坏`);
  store.close();
  inbox.close();
  process.exitCode = failed === 0 ? 0 : 1;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad(text: string, width: number) {
  const visual = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(width - visual, 1));
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
