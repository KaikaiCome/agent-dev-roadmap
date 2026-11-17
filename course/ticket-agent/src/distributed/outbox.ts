import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Store } from '../store.ts';
import type { Tool } from '../tools/types.ts';

// 第 23 章：事务性 outbox。业务状态和“要通知外部系统”的消息在同一个事务里写进同一个库，
// 再由 dispatcher 异步投递。投递是至少一次（at-least-once）：可能重复，但不会丢；
// 重复由消费端按消息 key 去重（Inbox），最终效果是每条消息恰好生效一次。

export const OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (state, available_at);
`;

export interface OutboxMessage {
  id: number;
  key: string;
  runId: string;
  topic: string;
  payload: unknown;
  attempts: number;
}

export interface OutboxOptions {
  /** 一批消息被某个 dispatcher 领走后，多久没确认就允许别人重新投递 */
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

type Row = Record<string, unknown>;

export class Outbox {
  readonly store: Store;
  #leaseMs: number;
  #maxAttempts: number;
  #now: () => number;

  constructor(store: Store, options: OutboxOptions = {}) {
    this.store = store;
    this.#leaseMs = options.leaseMs ?? 10_000;
    this.#maxAttempts = options.maxAttempts ?? 10;
    this.#now = options.now ?? Date.now;
    store.transaction(() => store.database.exec(OUTBOX_SCHEMA));
  }

  /** 必须在业务写入的同一个事务里调用。key 相同的消息只记一次 */
  add(message: { runId: string; topic: string; key: string; payload: unknown }) {
    const now = this.#now();
    this.store.database.prepare('INSERT OR IGNORE INTO outbox (message_key, run_id, topic, payload, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(message.key, message.runId, message.topic, JSON.stringify(message.payload), now, now);
  }

  /** 领一批待投递的消息。被别的 dispatcher 领走但租约过期的（它可能投递到一半崩溃了）也会被重新领取 */
  claim(owner: string, limit = 10): OutboxMessage[] {
    const now = this.#now();
    const rows = this.store.transaction(() => this.store.database.prepare(`
      UPDATE outbox SET lease_owner = :owner, lease_until = :until, attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox
        WHERE state = 'pending' AND available_at <= :now AND (lease_until IS NULL OR lease_until < :now)
        ORDER BY id LIMIT :limit
      )
      RETURNING id, message_key, run_id, topic, payload, attempts`).all({ owner, now, until: now + this.#leaseMs, limit }) as Row[]);
    return rows.map((row) => ({
      id: Number(row.id), key: String(row.message_key), runId: String(row.run_id),
      topic: String(row.topic), payload: JSON.parse(String(row.payload)), attempts: Number(row.attempts),
    })).sort((a, b) => a.id - b.id);
  }

  /** 投递成功。租约已被别人接手时什么也不改（对方会再投一次，消费端去重） */
  ack(message: OutboxMessage, owner: string): boolean {
    return Number(this.store.database.prepare("UPDATE outbox SET state = 'delivered', delivered_at = ?, lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ? AND state = 'pending'")
      .run(this.#now(), message.id, owner).changes) > 0;
  }

  /** 投递失败：指数退避后重试，次数用完标记为 dead 等人工处理 */
  nack(message: OutboxMessage, owner: string, error: string) {
    const now = this.#now();
    const dead = message.attempts >= this.#maxAttempts;
    this.store.database.prepare(`UPDATE outbox SET state = ?, available_at = ?, lease_owner = NULL, lease_until = NULL, last_error = ? WHERE id = ? AND lease_owner = ? AND state = 'pending'`)
      .run(dead ? 'dead' : 'pending', now + Math.min(200 * 2 ** message.attempts, 30_000), error.slice(0, 500), message.id, owner);
  }

  stats(): { pending: number; delivered: number; dead: number } {
    const rows = this.store.database.prepare('SELECT state, COUNT(*) AS n FROM outbox GROUP BY state').all() as Row[];
    const stats = { pending: 0, delivered: 0, dead: 0 };
    for (const row of rows) stats[String(row.state) as keyof typeof stats] = Number(row.n);
    return stats;
  }
}

export type Deliver = (message: OutboxMessage) => Promise<void>;

/** 投递一轮。一条失败不影响同批的其他消息 */
export async function dispatchOnce(outbox: Outbox, owner: string, deliver: Deliver, limit = 10): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;
  for (const message of outbox.claim(owner, limit)) {
    try {
      await deliver(message);
      outbox.ack(message, owner);
      delivered += 1;
    } catch (error) {
      outbox.nack(message, owner, String(error));
      failed += 1;
    }
  }
  return { delivered, failed };
}

/** 后台循环投递，直到 stop() */
export function startDispatcher(outbox: Outbox, owner: string, deliver: Deliver, options: { pollMs?: number; onError?: (error: unknown) => void } = {}) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    running = dispatchOnce(outbox, owner, deliver)
      .catch((error) => options.onError?.(error))
      .then((result) => {
        if (stopped) return;
        const busy = typeof result === 'object' && result !== null && (result.delivered + result.failed) > 0;
        timer = setTimeout(tick, busy ? 0 : options.pollMs ?? 200);
      });
  };
  tick();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

/** 把消息 POST 给外部系统。Idempotency-Key 头让对方能按 key 去重——这是消费端幂等的协议约定 */
export function webhookDelivery(url: string, timeoutMs = 5000): Deliver {
  return async (message) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': message.key },
      body: JSON.stringify({ topic: message.topic, key: message.key, payload: message.payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`webhook ${response.status}`);
  };
}

/**
 * create_ticket 改为：创建工单 + 写 outbox 消息，在同一个事务里。
 * 工单提交成功则消息一定在；事务被回滚（例如栅栏拒绝了僵尸 worker）则两者都不在。
 */
export function withTicketOutbox(tools: Tool[], outbox: Outbox): Tool[] {
  return tools.map((tool) => tool.spec.name !== 'create_ticket' ? tool : {
    ...tool,
    run: (args, context) => outbox.store.transaction(() => {
      const result = tool.run(args, context);
      if (result instanceof Promise) throw new Error('create_ticket 必须同步执行，才能和 outbox 写在同一个事务里');
      const { ticketId } = result as { ticketId: string };
      outbox.add({
        runId: context.runId,
        topic: 'ticket.created',
        key: `ticket.created:${ticketId}`,
        payload: { ticketId, tenantId: context.user.tenantId, userId: context.user.id },
      });
      return result;
    }),
  });
}

/**
 * 消费端（例如通知服务）的收件箱：按消息 key 去重，“记下收到过”和“产生效果”在同一个事务里。
 * 它模拟的是另一个系统，所以用自己的数据库文件。
 */
export class Inbox {
  #db: DatabaseSync;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    this.#db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS inbox (message_key TEXT PRIMARY KEY, topic TEXT NOT NULL, payload TEXT NOT NULL, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, message_key TEXT NOT NULL);`);
  }

  receive(message: { key: string; topic: string; payload: unknown }): 'applied' | 'duplicate' {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('INSERT INTO deliveries (message_key) VALUES (?)').run(message.key);
      const applied = Number(this.#db.prepare('INSERT OR IGNORE INTO inbox VALUES (?, ?, ?, ?)')
        .run(message.key, message.topic, JSON.stringify(message.payload), Date.now()).changes) > 0;
      this.#db.exec('COMMIT');
      return applied ? 'applied' : 'duplicate';
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** received = 收到的投递次数（含重复），applied = 实际生效的消息数 */
  stats(): { received: number; applied: number } {
    const count = (table: string) => Number((this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n);
    return { received: count('deliveries'), applied: count('inbox') };
  }

  keys(): string[] {
    return (this.#db.prepare('SELECT message_key FROM inbox ORDER BY message_key').all() as Row[]).map((row) => String(row.message_key));
  }

  close() {
    this.#db.close();
  }
}
