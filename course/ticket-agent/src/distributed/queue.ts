import { cancelIdleRun } from '../agent.ts';
import type { User } from '../data/seed.ts';
import type { RunStatus } from '../events.ts';
import type { Run, Store } from '../store.ts';
import { OUTBOX_SCHEMA } from './outbox.ts';

// 第 23 章：持久化的 run 队列。API 进程只负责入队，多个 worker 进程共享同一个 SQLite 文件领取任务。
// 领取 = 租约（owner + lease_until），续约靠心跳；租约过期后别的 worker 可以接手。
// 每次领取都让 fence（栅栏令牌）加 1，这个 run 的所有写入都要带着令牌检查，被接手后旧 worker 的写入一律失败。

export interface QueueOptions {
  /** 租约时长。worker 超过这么久没续约，就认为它已经死了 */
  leaseMs?: number;
  /** 一个 run 最多被领取几次，超过后进入死信 */
  maxAttempts?: number;
  /** 每个租户同时执行中的 run 上限，防止一个大客户占满所有 worker */
  tenantMaxInflight?: number;
  /** 每个租户排队中的 run 上限，超过就拒绝入队（背压） */
  tenantMaxQueued?: number;
  /** false = 不检查栅栏令牌。只用来演示没有栅栏时会出什么错，生产环境不要关 */
  fencing?: boolean;
  now?: () => number;
  /** 第 n 次失败后多久再试 */
  backoffMs?: (attempt: number) => number;
}

export interface Lease {
  runId: string;
  tenantId: string;
  userId: string;
  owner: string;
  fence: number;
  attempt: number;
  leaseUntil: number;
}

export type QueueState = 'queued' | 'leased' | 'parked' | 'done' | 'dead';

export interface QueueStats {
  queued: number;
  /** 租约有效、正在执行的 */
  inflight: number;
  /** 租约已过期、等待被接手的（持有者大概率已经崩溃或卡住） */
  expired: number;
  parked: number;
  done: number;
  dead: number;
  /** 最早一条排队任务已经等了多久，比队列长度更能反映用户感受到的延迟 */
  oldestQueuedMs: number;
  tenants: Record<string, { queued: number; inflight: number }>;
}

/** 写入被拒绝：这个 worker 的租约已经被别人接手，它手里的状态是过期的 */
export class FencedError extends Error {
  constructor(runId: string) {
    super(`FENCED: run ${runId} 已被其他 worker 接手`);
    this.name = 'FencedError';
  }
}

export function isFenced(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('FENCED');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_queue (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  fence INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  lease_until INTEGER,
  available_at INTEGER NOT NULL,
  last_error TEXT,
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS run_queue_ready ON run_queue (state, available_at);
CREATE INDEX IF NOT EXISTS run_queue_tenant ON run_queue (tenant_id, state);
${OUTBOX_SCHEMA}
`;

// 栅栏放在存储层：每个 worker 的连接上记着“我持有哪个 run 的第几号令牌”，
// 对这个 run 的写入在同一条 SQL 里和队列里的最新令牌比对，不一致就中止整个事务。
// 用触发器而不是在每个调用点手写检查，是为了没有任何一条写路径能漏掉它（包括 agent.ts 里不知道队列存在的代码）
const guarded: Array<[table: string, op: 'INSERT' | 'UPDATE', runIdColumn: string]> = [
  ['runs', 'UPDATE', 'id'],
  ['events', 'INSERT', 'run_id'],
  ['drafts', 'INSERT', 'run_id'],
  ['memories', 'INSERT', 'source_run_id'],
  ['outbox', 'INSERT', 'run_id'],
];
const FENCING = `
CREATE TEMP TABLE IF NOT EXISTS fence_ctx (run_id TEXT PRIMARY KEY, fence INTEGER NOT NULL);
${guarded.map(([table, op, column]) => `
CREATE TEMP TRIGGER IF NOT EXISTS fence_${table} BEFORE ${op} ON main.${table}
WHEN EXISTS (SELECT 1 FROM temp.fence_ctx c JOIN main.run_queue q ON q.run_id = c.run_id
             WHERE c.run_id = NEW.${column} AND q.fence != c.fence)
BEGIN SELECT RAISE(ABORT, 'FENCED: stale fencing token'); END;`).join('\n')}
`;

const INFLIGHT = `(SELECT COUNT(*) FROM run_queue l WHERE l.tenant_id = q.tenant_id AND l.state = 'leased' AND l.lease_until >= :now)`;

// 一条 UPDATE ... RETURNING 完成“挑一个 + 占住它”。SQLite 的写语句开始执行前就拿到了写锁，
// 两个进程不可能领到同一条。挑选顺序：先选在途最少的租户（公平），再按可执行时间和入队时间
const CLAIM = `
UPDATE run_queue
SET state = 'leased', owner = :owner, lease_until = :until, fence = fence + 1, attempt = attempt + 1, updated_at = :now
WHERE run_id = (
  SELECT q.run_id FROM run_queue q
  WHERE ((q.state = 'queued' AND q.available_at <= :now) OR (q.state = 'leased' AND q.lease_until < :now))
    AND q.run_id NOT IN (SELECT value FROM json_each(:exclude))
    AND ${INFLIGHT} < :limit
  ORDER BY ${INFLIGHT}, q.available_at, q.enqueued_at
  LIMIT 1
)
RETURNING run_id, tenant_id, user_id, fence, attempt, lease_until`;

type Row = Record<string, unknown>;

export class RunQueue {
  readonly store: Store;
  readonly leaseMs: number;
  readonly fencing: boolean;
  #maxAttempts: number;
  #tenantMaxInflight: number;
  #tenantMaxQueued: number;
  #now: () => number;
  #backoff: (attempt: number) => number;

  constructor(store: Store, options: QueueOptions = {}) {
    this.store = store;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.fencing = options.fencing ?? true;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#tenantMaxInflight = options.tenantMaxInflight ?? 4;
    this.#tenantMaxQueued = options.tenantMaxQueued ?? 100;
    this.#now = options.now ?? Date.now;
    this.#backoff = options.backoffMs ?? ((attempt) => Math.min(1000 * 2 ** (attempt - 1), 30_000));
    store.transaction(() => store.database.exec(SCHEMA));
    if (this.fencing) store.database.exec(FENCING);
  }

  /** 创建 run 并入队，两件事在同一个事务里：不会出现“run 建了但没人执行” */
  submit(user: User, question: string): { ok: true; run: Run } | { ok: false; message: string } {
    return this.store.transaction(() => {
      const queued = Number((this.store.database.prepare("SELECT COUNT(*) AS n FROM run_queue WHERE tenant_id = ? AND state = 'queued'")
        .get(user.tenantId) as Row).n);
      if (queued >= this.#tenantMaxQueued) return { ok: false as const, message: `排队中的任务已达上限 ${this.#tenantMaxQueued}，请稍后再试` };
      const run = this.store.createRun(user, question);
      this.enqueue(run.id);
      return { ok: true as const, run };
    });
  }

  /** 把 run 放进队列（新建或审批后恢复）。令牌不清零，只增不减 */
  enqueue(runId: string) {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} 不存在`);
    const now = this.#now();
    this.store.database.prepare(`
      INSERT INTO run_queue (run_id, tenant_id, user_id, state, max_attempts, available_at, enqueued_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
      ON CONFLICT (run_id) DO UPDATE SET state = 'queued', attempt = 0, owner = NULL, lease_until = NULL,
        available_at = excluded.available_at, enqueued_at = excluded.enqueued_at, updated_at = excluded.updated_at`)
      .run(run.id, run.tenantId, run.userId, this.#maxAttempts, now, now, now);
  }

  /** 执行 fn（例如记录审批决定），成功就把 run 放回队列。两者在同一个事务里 */
  resumeAfter<T extends { ok: boolean }>(runId: string, fn: () => T): T {
    return this.store.transaction(() => {
      const result = fn();
      if (result.ok) this.enqueue(runId);
      return result;
    });
  }

  /** 取消。令牌加 1，正在执行它的 worker 下一次写入就会失败，相当于跨进程的中断信号 */
  cancel(runId: string): boolean {
    return this.store.transaction(() => {
      if (!cancelIdleRun(this.store, runId)) return false;
      this.store.database.prepare("UPDATE run_queue SET state = 'done', fence = fence + 1, owner = NULL, lease_until = NULL, updated_at = ? WHERE run_id = ?")
        .run(this.#now(), runId);
      return true;
    });
  }

  /**
   * 领取一个可执行的 run。没有可领的（或都被租户并发上限挡住）返回 undefined。
   * exclude 传本进程仍在执行的 run：栅栏上下文按连接记录，同一进程重新领取自己卡住的 run 会把旧令牌覆盖成新令牌，
   * 旧任务的僵尸写入就能通过检查；它结束时 forget() 还会删掉新任务的上下文。交给别的进程接手，栅栏才有效
   */
  claim(owner: string, exclude: Iterable<string> = []): Lease | undefined {
    const now = this.#now();
    return this.store.transaction(() => {
      this.#deadLetterExpired(now);
      const row = this.store.database.prepare(CLAIM)
        .get({ owner, now, until: now + this.leaseMs, limit: this.#tenantMaxInflight, exclude: JSON.stringify([...exclude]) }) as Row | undefined;
      if (!row) return undefined;
      const lease: Lease = {
        runId: String(row.run_id), tenantId: String(row.tenant_id), userId: String(row.user_id),
        owner, fence: Number(row.fence), attempt: Number(row.attempt), leaseUntil: Number(row.lease_until),
      };
      if (this.fencing) this.store.database.prepare('INSERT OR REPLACE INTO temp.fence_ctx VALUES (?, ?)').run(lease.runId, lease.fence);
      return lease;
    });
  }

  /** 续约。返回 false 表示租约已经被别人接手，应当立刻停止这个 run */
  heartbeat(lease: Lease): boolean {
    const until = this.#now() + this.leaseMs;
    const changes = this.store.database.prepare(`UPDATE run_queue SET lease_until = ? WHERE run_id = ? AND state = 'leased' AND ${this.#holds()}`)
      .run(until, lease.runId, this.#token(lease)).changes;
    if (Number(changes) === 0) return false;
    lease.leaseUntil = until;
    return true;
  }

  /**
   * 执行结束，按 run 的状态更新队列：结束 → done，等审批 → parked，服务重启中断 → 放回队列（不消耗重试次数）。
   * 租约已经被接手时抛出 FencedError，什么也不改。
   */
  complete(lease: Lease, status: RunStatus) {
    const state: QueueState = status === 'waiting_approval' ? 'parked' : status === 'running' ? 'queued' : 'done';
    const now = this.#now();
    try {
      const changes = this.store.database.prepare(`
        UPDATE run_queue SET state = ?, owner = NULL, lease_until = NULL, available_at = ?, updated_at = ?,
          attempt = CASE WHEN ? = 'queued' THEN attempt - 1 ELSE attempt END
        WHERE run_id = ? AND state = 'leased' AND ${this.#holds()}`)
        .run(state, now, now, state, lease.runId, this.#token(lease)).changes;
      if (Number(changes) === 0) throw new FencedError(lease.runId);
    } finally {
      this.forget(lease.runId);
    }
  }

  /** worker 层面的异常（不是 run 自己的失败）。按退避重试，次数用完进死信 */
  fail(lease: Lease, error: string) {
    const now = this.#now();
    try {
      this.store.transaction(() => {
        const row = this.store.database.prepare(`SELECT attempt, max_attempts FROM run_queue WHERE run_id = ? AND state = 'leased' AND ${this.#holds()}`)
          .get(lease.runId, this.#token(lease)) as Row | undefined;
        if (!row) throw new FencedError(lease.runId);
        if (Number(row.attempt) >= Number(row.max_attempts)) return this.#deadLetter(lease.runId, error, now);
        this.store.database.prepare("UPDATE run_queue SET state = 'queued', owner = NULL, lease_until = NULL, available_at = ?, last_error = ?, updated_at = ? WHERE run_id = ?")
          .run(now + this.#backoff(Number(row.attempt)), error.slice(0, 500), now, lease.runId);
      });
    } finally {
      this.forget(lease.runId);
    }
  }

  /** 这个连接不再持有该 run 的令牌 */
  forget(runId: string) {
    if (this.fencing) this.store.database.prepare('DELETE FROM temp.fence_ctx WHERE run_id = ?').run(runId);
  }

  state(runId: string): { state: QueueState; attempt: number; fence: number; owner: string | null; lastError: string | null } | undefined {
    const row = this.store.database.prepare('SELECT * FROM run_queue WHERE run_id = ?').get(runId) as Row | undefined;
    if (!row) return undefined;
    return {
      state: row.state as QueueState, attempt: Number(row.attempt), fence: Number(row.fence),
      owner: row.owner === null ? null : String(row.owner), lastError: row.last_error === null ? null : String(row.last_error),
    };
  }

  /** 死信：需要人工查看原因，修复后可以重新 enqueue */
  deadLetters(): Array<{ runId: string; tenantId: string; attempt: number; lastError: string }> {
    return (this.store.database.prepare("SELECT run_id, tenant_id, attempt, last_error FROM run_queue WHERE state = 'dead' ORDER BY updated_at").all() as Row[])
      .map((row) => ({ runId: String(row.run_id), tenantId: String(row.tenant_id), attempt: Number(row.attempt), lastError: String(row.last_error ?? '') }));
  }

  stats(): QueueStats {
    const now = this.#now();
    const stats: QueueStats = { queued: 0, inflight: 0, expired: 0, parked: 0, done: 0, dead: 0, oldestQueuedMs: 0, tenants: {} };
    const rows = this.store.database.prepare(`
      SELECT tenant_id,
        CASE WHEN state = 'leased' AND lease_until < :now THEN 'expired' WHEN state = 'leased' THEN 'inflight' ELSE state END AS bucket,
        COUNT(*) AS n, MIN(enqueued_at) AS oldest
      FROM run_queue GROUP BY tenant_id, bucket`).all({ now }) as Row[];
    for (const row of rows) {
      const bucket = String(row.bucket) as 'queued' | 'inflight' | 'expired' | 'parked' | 'done' | 'dead';
      const n = Number(row.n);
      stats[bucket] += n;
      const tenant = (stats.tenants[String(row.tenant_id)] ??= { queued: 0, inflight: 0 });
      if (bucket === 'queued' || bucket === 'inflight') tenant[bucket] += n;
      if (bucket === 'queued') stats.oldestQueuedMs = Math.max(stats.oldestQueuedMs, now - Number(row.oldest));
    }
    return stats;
  }

  /** 关掉栅栏时退化成“按 owner 判断是不是自己的”：这正是会被僵尸 worker 骗过的写法 */
  #holds() {
    return this.fencing ? 'fence = ?' : 'owner = ?';
  }

  #token(lease: Lease): number | string {
    return this.fencing ? lease.fence : lease.owner;
  }

  /** 租约过期、而且重试次数已经用完的，不再交给下一个 worker，直接进死信 */
  #deadLetterExpired(now: number) {
    const rows = this.store.database.prepare("SELECT run_id, attempt FROM run_queue WHERE state = 'leased' AND lease_until < ? AND attempt >= max_attempts")
      .all(now) as Row[];
    for (const row of rows) this.#deadLetter(String(row.run_id), `租约过期，已尝试 ${row.attempt} 次`, now);
  }

  /** 进死信时令牌加 1，并把 run 标记为失败：用户看到明确的结果，而不是永远“执行中” */
  #deadLetter(runId: string, error: string, now: number) {
    this.forget(runId);
    this.store.database.prepare("UPDATE run_queue SET state = 'dead', fence = fence + 1, owner = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE run_id = ?")
      .run(error.slice(0, 500), now, runId);
    const run = this.store.getRun(runId);
    if (run && (run.status === 'running' || run.status === 'waiting_approval')) {
      this.store.append(runId, 'run_finished', { status: 'failed', reason: '多次执行失败，已转人工处理' });
      this.store.setStatus(runId, 'failed');
    }
  }
}

export function queueOptionsFromEnv(env: Record<string, string | undefined> = process.env): QueueOptions {
  const positive = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数，当前是 ${env[name]}`);
    return value;
  };
  return {
    leaseMs: positive('QUEUE_LEASE_MS', 30_000),
    maxAttempts: positive('QUEUE_MAX_ATTEMPTS', 5),
    tenantMaxInflight: positive('TENANT_MAX_INFLIGHT', 4),
    tenantMaxQueued: positive('TENANT_MAX_QUEUED', 100),
  };
}
