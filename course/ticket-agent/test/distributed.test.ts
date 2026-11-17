import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { resolveApproval } from '../src/agent.ts';
import { findUser } from '../src/data/seed.ts';
import { dispatchOnce, Inbox, Outbox, withTicketOutbox } from '../src/distributed/outbox.ts';
import { RunQueue, type QueueOptions } from '../src/distributed/queue.ts';
import { agentExecutor, QueueWorker } from '../src/distributed/worker.ts';
import { createMockModel } from '../src/llm/mock.ts';
import { Store } from '../src/store.ts';
import { ticketTools } from '../src/tools/tickets.ts';
import { createTools } from '../src/tools/index.ts';

const alice = findUser('alice')!;
const carol = findUser('carol')!;
const bob = findUser('bob')!;

const dir = join(import.meta.dirname, '..', 'data', `test-distributed-${randomUUID().slice(0, 8)}`);
mkdirSync(dir, { recursive: true });
after(() => rmSync(dir, { recursive: true, force: true }));
const dbFile = () => join(dir, `${randomUUID().slice(0, 8)}.db`);

/** 两个“worker”= 同一个数据库文件上的两个连接，共用一个可拨动的时钟 */
function twoWorkers(options: QueueOptions = {}) {
  const path = dbFile();
  const clock = { now: 1_000_000 };
  const open = () => {
    const store = new Store(path);
    return { store, queue: new RunQueue(store, { leaseMs: 1000, now: () => clock.now, ...options }) };
  };
  const a = open();
  const b = open();
  return { clock, a, b, close: () => { a.store.close(); b.store.close(); } };
}

test('多个进程同时抢任务：每个 run 只被领取一次', async () => {
  const path = dbFile();
  const store = new Store(path);
  const queue = new RunQueue(store, { tenantMaxQueued: 1000 });
  const ids = new Set<string>();
  store.transaction(() => {
    for (let i = 0; i < 200; i++) {
      const submitted = queue.submit(i % 2 ? alice : bob, `问题 ${i}`);
      if (submitted.ok) ids.add(submitted.run.id);
    }
  });
  store.close();

  const startAt = Date.now() + 1000;
  const fixture = join(import.meta.dirname, 'fixtures', 'claim-worker.ts');
  const outputs = await Promise.all([1, 2, 3, 4].map((n) =>
    promisify(execFile)(process.execPath, [fixture, path, `w${n}`, String(startAt)], { timeout: 30_000 })));
  const claimed = outputs.map((output) => JSON.parse(output.stdout) as string[]);

  const all = claimed.flat();
  assert.equal(all.length, 200, '没有重复领取');
  assert.deepEqual(new Set(all), ids, '没有漏掉');
  assert.ok(claimed.filter((list) => list.length > 0).length >= 2, `确实发生了并发争抢：${claimed.map((l) => l.length)}`);
});

test('租约过期后被其他 worker 接手，令牌加 1，旧 worker 续约失败', () => {
  const { clock, a, b, close } = twoWorkers();
  const run = a.queue.submit(alice, 'VPN 连不上');
  assert.ok(run.ok);

  const leaseA = a.queue.claim('A')!;
  assert.deepEqual([leaseA.fence, leaseA.attempt], [1, 1]);
  assert.equal(b.queue.claim('B'), undefined, '租约有效期内别人领不到');
  clock.now += 800;
  assert.ok(a.queue.heartbeat(leaseA), '按时续约');
  clock.now += 800;
  assert.equal(b.queue.claim('B'), undefined, '续约后租约延长了');

  clock.now += 1500;
  const leaseB = b.queue.claim('B')!;
  assert.equal(leaseB.runId, run.run.id);
  assert.deepEqual([leaseB.fence, leaseB.attempt], [2, 2]);
  assert.equal(a.queue.heartbeat(leaseA), false, 'A 发现自己已经失去租约');
  close();
});

test('栅栏令牌：卡住后醒来的旧 worker 写不进任何东西；关掉栅栏就会写出重复工单', () => {
  for (const fencing of [true, false]) {
    const { clock, a, b, close } = twoWorkers({ fencing });
    const submitted = a.queue.submit(alice, '帮我提交工单：显示器坏了');
    assert.ok(submitted.ok);
    const runId = submitted.run.id;
    const draft = a.store.saveDraft({ runId, tenantId: alice.tenantId, userId: alice.id, title: '显示器坏了', description: '黑屏', sourceIds: [] });
    const tool = (side: typeof a) => withTicketOutbox(ticketTools(side.store), new Outbox(side.store)).find((t) => t.spec.name === 'create_ticket')!;
    const context = (callId: string) => ({ user: alice, runId, callId, signal: new AbortController().signal });

    const leaseA = a.queue.claim('A')!;
    clock.now += 5000; // A 卡住（GC 停顿、网络分区），租约过期
    const leaseB = b.queue.claim('B')!;
    tool(b).run({ draftId: draft.id }, context('call_b'));
    b.store.append(runId, 'run_finished', { status: 'completed' });
    b.store.setStatus(runId, 'completed');
    b.queue.complete(leaseB, 'completed');

    // A 醒来，按它“以为”的状态继续执行
    const zombie = [
      () => tool(a).run({ draftId: draft.id }, context('call_a')),
      () => a.store.append(runId, 'run_finished', { status: 'cancelled', reason: '僵尸写入' }),
      () => a.store.setStatus(runId, 'cancelled'),
    ];
    if (fencing) {
      for (const write of zombie) assert.throws(write, /FENCED/);
      assert.throws(() => a.queue.complete(leaseA, 'cancelled'), /FENCED/);
      assert.equal(a.store.tickets(alice.tenantId).length, 1);
      assert.equal(a.store.getRun(runId)!.status, 'completed');
      assert.equal(new Outbox(a.store).stats().pending, 1, '被拒绝的工单连同它的 outbox 消息一起回滚');
    } else {
      zombie.forEach((write) => write());
      assert.equal(a.store.tickets(alice.tenantId).length, 2, '没有栅栏：同一个请求出现两张工单');
      assert.equal(a.store.getRun(runId)!.status, 'cancelled', '没有栅栏：已完成的 run 被覆盖');
      assert.equal(a.store.events(runId).filter((e) => e.type === 'run_finished').length, 2);
    }
    close();
  }
});

test('同一进程不会重新领取自己仍在执行的 run：交给别的进程接手，旧任务的写入照样被栅栏挡住', () => {
  const { clock, a, b, close } = twoWorkers();
  const submitted = a.queue.submit(alice, 'VPN 连不上');
  assert.ok(submitted.ok);
  const runId = submitted.run.id;

  a.queue.claim('A')!;
  clock.now += 5000; // A 进程整体卡住，醒来后主循环先于旧任务运行，又去领任务
  assert.equal(a.queue.claim('A', [runId]), undefined, '旧任务还在本进程执行，不能自己接手自己');
  const leaseB = b.queue.claim('B')!;
  assert.equal(leaseB.runId, runId);
  b.store.append(runId, 'run_finished', { status: 'completed' });
  b.store.setStatus(runId, 'completed');
  b.queue.complete(leaseB, 'completed');

  assert.throws(() => a.store.append(runId, 'run_finished', { status: 'cancelled', reason: '僵尸写入' }), /FENCED/);
  assert.equal(a.store.events(runId).filter((e) => e.type === 'run_finished').length, 1);
  close();
});

test('outbox：重复投递时消费端只生效一次；业务事务回滚时消息也不存在', async () => {
  const store = new Store(':memory:');
  const clock = { now: 0 };
  const outbox = new Outbox(store, { leaseMs: 1000, now: () => clock.now });
  const inbox = new Inbox(':memory:');
  const run = store.createRun(alice, 'q');
  store.transaction(() => ['t1', 't2', 't3'].forEach((id) => outbox.add({ runId: run.id, topic: 'ticket.created', key: `ticket.created:${id}`, payload: { id } })));
  assert.throws(() => store.transaction(() => {
    outbox.add({ runId: run.id, topic: 'ticket.created', key: 'ticket.created:t4', payload: {} });
    throw new Error('业务写入失败');
  }));
  store.transaction(() => outbox.add({ runId: run.id, topic: 'ticket.created', key: 'ticket.created:t1', payload: {} }));

  // dispatcher 1 投递成功，但在确认前崩溃
  const first = outbox.claim('d1');
  assert.equal(first.length, 3);
  first.forEach((message) => inbox.receive(message));

  // 租约过期，dispatcher 2 重新投递；第一次投 t2 时网络抖动失败
  clock.now += 1001;
  let flaky = true;
  const deliver = async (message: { key: string; topic: string; payload: unknown }) => {
    if (message.key.endsWith('t2') && flaky) { flaky = false; throw new Error('ECONNRESET'); }
    inbox.receive(message);
  };
  assert.deepEqual(await dispatchOnce(outbox, 'd2', deliver), { delivered: 2, failed: 1 });
  assert.equal(outbox.ack(first[0], 'd1'), false, '旧 dispatcher 的确认作废');
  clock.now += 10_000;
  assert.deepEqual(await dispatchOnce(outbox, 'd2', deliver), { delivered: 1, failed: 0 });

  assert.deepEqual(outbox.stats(), { pending: 0, delivered: 3, dead: 0 });
  assert.deepEqual(inbox.stats(), { received: 6, applied: 3 }, '投递 6 次，生效 3 次');
  assert.deepEqual(inbox.keys(), ['ticket.created:t1', 'ticket.created:t2', 'ticket.created:t3']);
});

test('重试次数用完进入死信，run 标记为失败而不是永远“执行中”', () => {
  const { clock, a, b, close } = twoWorkers({ maxAttempts: 2 });
  const submitted = a.queue.submit(bob, '出差标准');
  assert.ok(submitted.ok);
  assert.ok(a.queue.claim('A'));
  clock.now += 2000;
  const leaseB = b.queue.claim('B')!;
  assert.equal(leaseB.attempt, 2);
  clock.now += 2000;
  assert.equal(a.queue.claim('A'), undefined, '第三次不再交给任何 worker');

  assert.equal(a.queue.state(submitted.run.id)!.state, 'dead');
  assert.equal(a.queue.deadLetters().length, 1);
  assert.equal(a.store.getRun(submitted.run.id)!.status, 'failed');
  assert.match(JSON.stringify(a.store.events(submitted.run.id).at(-1)), /转人工处理/);
  assert.equal(b.queue.heartbeat(leaseB), false, '进死信时令牌已变，最后的持有者醒来也续不上约');
  close();
});

test('租户并发上限与排队上限：大租户占不满所有 worker，排队太多时拒绝入队', () => {
  const store = new Store(':memory:');
  const queue = new RunQueue(store, { tenantMaxInflight: 1, tenantMaxQueued: 2 });
  const acme1 = queue.submit(alice, 'a1');
  const acme2 = queue.submit(carol, 'a2');
  const rejected = queue.submit(alice, 'a3');
  const globex = queue.submit(bob, 'g1');
  assert.ok(acme1.ok && acme2.ok && globex.ok);
  assert.equal(rejected.ok, false, 'acme 已有 2 个在排队');

  const first = queue.claim('w')!;
  assert.equal(first.runId, acme1.run.id);
  assert.equal(queue.claim('w')!.runId, globex.run.id, 'acme 达到在途上限，轮到 globex');
  assert.equal(queue.claim('w'), undefined, 'acme 还有排队的，但不能超过上限');
  assert.deepEqual(queue.stats().tenants, { acme: { queued: 1, inflight: 1 }, globex: { queued: 0, inflight: 1 } });

  queue.complete(first, 'completed');
  assert.equal(queue.claim('w')!.runId, acme2.run.id);
});

test('worker 端到端：执行到审批时挂起，批准后重新入队并完成，工单通知只生效一次', async () => {
  const store = new Store(':memory:');
  const queue = new RunQueue(store, { leaseMs: 500 });
  const outbox = new Outbox(store);
  const tools = withTicketOutbox(createTools(store), outbox);
  const worker = new QueueWorker({ queue, execute: agentExecutor({ model: createMockModel(), store, tools }), pollMs: 10 });
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(check());
  };
  worker.start();
  const submitted = queue.submit(alice, '帮我提交工单：显示器坏了');
  assert.ok(submitted.ok);
  const runId = submitted.run.id;

  await waitFor(() => queue.state(runId)?.state === 'parked');
  assert.equal(store.getRun(runId)!.status, 'waiting_approval');
  const request = store.events(runId).findLast((e) => e.type === 'approval_requested');
  assert.ok(request?.type === 'approval_requested');
  queue.resumeAfter(runId, () => resolveApproval(store, runId, alice, request.data.callId, true));
  await waitFor(() => queue.state(runId)?.state === 'done');
  await worker.stop();

  assert.equal(store.getRun(runId)!.status, 'completed');
  assert.equal(store.tickets(alice.tenantId).length, 1);
  const inbox = new Inbox(':memory:');
  await dispatchOnce(outbox, 'd', async (message) => { inbox.receive(message); });
  assert.deepEqual(inbox.stats(), { received: 1, applied: 1 });
});
