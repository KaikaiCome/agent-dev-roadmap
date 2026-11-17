import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { User } from './data/seed.ts';
import type { AgentEvent, EventData, EventType, RunStatus } from './events.ts';

export interface Run {
  id: string;
  tenantId: string;
  userId: string;
  question: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Draft {
  id: string;
  runId: string;
  tenantId: string;
  userId: string;
  title: string;
  description: string;
  sourceIds: string[];
}

export interface RunLink {
  parentRunId: string;
  parentCallId: string;
  /** 子 Agent 的名字，例如 research */
  agent: string;
}

export interface MemoryRecord {
  id: string;
  tenantId: string;
  userId: string;
  /** 记的是哪一项，例如“电脑资产编号”。同一员工同一 key 只保留最新一条 */
  key: string;
  content: string;
  /** 哪次 run 里经员工确认写入的，用于溯源 */
  sourceRunId: string;
  createdAt: string;
  expiresAt: string;
}

export interface Ticket {
  id: string;
  idempotencyKey: string;
  tenantId: string;
  userId: string;
  draftId: string;
  title: string;
  createdAt: string;
}

// 每张表都带 tenant_id，查询时总是带上它，这是多租户隔离的底线
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  source_ids TEXT NOT NULL
);
-- 模拟的“外部工单系统”。idempotency_key 唯一，重复提交只会得到同一张工单
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- 第 19 章：子 Agent 的 run 挂在父 run 的某次工具调用下面，审计时能还原整棵调用树。
-- 同一次调用只能有一个子 run：崩溃恢复后重新执行这次调用，会接着跑原来的子 run
CREATE TABLE IF NOT EXISTS run_links (
  child_run_id TEXT PRIMARY KEY REFERENCES runs(id),
  parent_run_id TEXT NOT NULL REFERENCES runs(id),
  parent_call_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  UNIQUE (parent_run_id, parent_call_id)
);
-- 第 19 章：长期记忆。按租户 + 员工隔离；key 相同的新记忆覆盖旧的；过期后不再注入
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_owner ON memories (tenant_id, user_id);
`;

type Row = Record<string, unknown>;

export class Store {
  #db: DatabaseSync;
  #listeners = new Set<(event: AgentEvent) => void>();
  #pending: AgentEvent[] | null = null;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    // timeout = busy_timeout：多个进程共享同一个文件时（第 23 章），拿不到写锁先等待，而不是立刻报 SQLITE_BUSY
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);
  }

  close() {
    this.#db.close();
  }

  /** 第 23 章：队列和 outbox 需要在同一个连接、同一个事务里读写自己的表，并安装栅栏检查 */
  get database(): DatabaseSync {
    return this.#db;
  }

  /** 多条写入要么全部成功、要么全部回滚。事件在提交成功后才通知订阅者。嵌套调用并入外层事务 */
  transaction<T>(fn: () => T): T {
    if (this.#pending) return fn();
    this.#db.exec('BEGIN IMMEDIATE');
    this.#pending = [];
    let result: T;
    let committed: AgentEvent[];
    try {
      result = fn();
      this.#db.exec('COMMIT');
      committed = this.#pending;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#pending = null;
    }
    // 已经提交成功，通知放在事务之外：订阅者出错不能影响数据
    committed.forEach((event) => this.#emit(event));
    return result;
  }

  /** parent 不为空表示这是子 Agent 的 run（第 19 章），和父 run 的关联与 run 本身在同一个事务里写入 */
  createRun(user: User, question: string, parent?: RunLink): Run {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.transaction(() => {
      this.#db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, user.tenantId, user.id, question, 'running', now, now);
      if (parent) {
        this.#db.prepare('INSERT INTO run_links VALUES (?, ?, ?, ?)').run(id, parent.parentRunId, parent.parentCallId, parent.agent);
      }
      this.append(id, 'run_started', { question, userId: user.id, ...parent });
    });
    return this.getRun(id)!;
  }

  getRun(id: string): Run | undefined {
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? toRun(row) : undefined;
  }

  /** 只返回顶层 run。子 run 由父 run 重新执行那次工具调用时接着跑，不能被当成独立任务恢复（否则会拿到父 Agent 的全部工具） */
  runsWithStatus(status: RunStatus): Run[] {
    return (this.#db.prepare('SELECT * FROM runs WHERE status = ? AND id NOT IN (SELECT child_run_id FROM run_links) ORDER BY created_at').all(status) as Row[]).map(toRun);
  }

  /** 父 run 的某次工具调用创建的子 run */
  childRun(parentRunId: string, parentCallId: string): Run | undefined {
    const row = this.#db.prepare('SELECT runs.* FROM runs JOIN run_links ON runs.id = run_links.child_run_id WHERE parent_run_id = ? AND parent_call_id = ?')
      .get(parentRunId, parentCallId) as Row | undefined;
    return row ? toRun(row) : undefined;
  }

  childRuns(parentRunId: string): Run[] {
    return (this.#db.prepare('SELECT runs.* FROM runs JOIN run_links ON runs.id = run_links.child_run_id WHERE parent_run_id = ? ORDER BY runs.created_at')
      .all(parentRunId) as Row[]).map(toRun);
  }

  setStatus(runId: string, status: RunStatus) {
    this.#db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), runId);
  }

  /** 追加一条事件，序号由数据库在同一条 SQL 里分配，保证每个 run 内连续递增 */
  append<K extends EventType>(runId: string, type: K, data: EventData[K]): AgentEvent {
    const createdAt = new Date().toISOString();
    const row = this.#db.prepare(`
      INSERT INTO events (run_id, seq, type, data, created_at)
      SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ? FROM events WHERE run_id = ?
      RETURNING seq`).get(runId, type, JSON.stringify(data), createdAt, runId) as Row;
    const event = { runId, seq: Number(row.seq), type, data, createdAt } as AgentEvent;
    if (this.#pending) this.#pending.push(event);
    else this.#emit(event);
    return event;
  }

  events(runId: string, afterSeq = 0): AgentEvent[] {
    const rows = this.#db.prepare('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq')
      .all(runId, afterSeq) as Row[];
    return rows.map((row) => ({
      runId: String(row.run_id),
      seq: Number(row.seq),
      type: row.type,
      data: JSON.parse(String(row.data)),
      createdAt: String(row.created_at),
    }) as AgentEvent);
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  saveDraft(draft: Omit<Draft, 'id'>): Draft {
    const id = `draft_${randomUUID().slice(0, 8)}`;
    this.#db.prepare('INSERT INTO drafts VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, draft.runId, draft.tenantId, draft.userId, draft.title, draft.description, JSON.stringify(draft.sourceIds));
    return { id, ...draft };
  }

  getDraft(id: string): Draft | undefined {
    const row = this.#db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      runId: String(row.run_id),
      tenantId: String(row.tenant_id),
      userId: String(row.user_id),
      title: String(row.title),
      description: String(row.description),
      sourceIds: JSON.parse(String(row.source_ids)),
    };
  }

  /** 幂等创建：同一个 key 无论调用多少次，只会产生一张工单 */
  createTicketOnce(input: Omit<Ticket, 'id' | 'createdAt'>): { ticket: Ticket; created: boolean } {
    return this.transaction(() => {
      const existing = this.#db.prepare('SELECT * FROM tickets WHERE idempotency_key = ?')
        .get(input.idempotencyKey) as Row | undefined;
      if (existing) return { ticket: toTicket(existing), created: false };
      const ticket: Ticket = { ...input, id: `TCK-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4)}`, createdAt: new Date().toISOString() };
      this.#db.prepare('INSERT INTO tickets VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ticket.id, ticket.idempotencyKey, ticket.tenantId, ticket.userId, ticket.draftId, ticket.title, ticket.createdAt);
      return { ticket, created: true };
    });
  }

  tickets(tenantId: string): Ticket[] {
    return (this.#db.prepare('SELECT * FROM tickets WHERE tenant_id = ? ORDER BY created_at').all(tenantId) as Row[]).map(toTicket);
  }

  /**
   * 写入一条记忆。内容完全相同 = 重复，只延长有效期；
   * onConflict=replace 时同一 key 的旧记忆被删除（“我的资产编号换了”），append 时新旧并存。
   */
  saveMemory(input: Omit<MemoryRecord, 'id' | 'createdAt'>, onConflict: 'replace' | 'append' = 'replace'): { memory: MemoryRecord; status: 'created' | 'replaced' | 'duplicate' } {
    return this.transaction(() => {
      const owner = [input.tenantId, input.userId] as const;
      const same = this.#db.prepare('SELECT * FROM memories WHERE tenant_id = ? AND user_id = ? AND content = ?')
        .get(...owner, input.content) as Row | undefined;
      if (same) {
        this.#db.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(input.expiresAt, String(same.id));
        return { memory: { ...toMemory(same), expiresAt: input.expiresAt }, status: 'duplicate' as const };
      }
      const replaced = onConflict === 'replace'
        ? Number(this.#db.prepare('DELETE FROM memories WHERE tenant_id = ? AND user_id = ? AND key = ?').run(...owner, input.key).changes)
        : 0;
      const memory: MemoryRecord = { ...input, id: `mem_${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString() };
      this.#db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(memory.id, memory.tenantId, memory.userId, memory.key, memory.content, memory.sourceRunId, memory.createdAt, memory.expiresAt);
      return { memory, status: replaced > 0 ? 'replaced' as const : 'created' as const };
    });
  }

  /** 某个员工未过期的记忆，最新的在前。租户和员工两个条件缺一不可 */
  memories(tenantId: string, userId: string, now = new Date()): MemoryRecord[] {
    return (this.#db.prepare('SELECT * FROM memories WHERE tenant_id = ? AND user_id = ? AND expires_at > ? ORDER BY created_at DESC, rowid DESC')
      .all(tenantId, userId, now.toISOString()) as Row[]).map(toMemory);
  }

  /** 删除一条记忆；id 不属于这个员工时什么也不做 */
  deleteMemory(tenantId: string, userId: string, id: string): boolean {
    return Number(this.#db.prepare('DELETE FROM memories WHERE tenant_id = ? AND user_id = ? AND id = ?').run(tenantId, userId, id).changes) > 0;
  }

  /** 删除一个员工的全部记忆（被遗忘权），包括已过期的 */
  deleteMemories(tenantId: string, userId: string): number {
    return Number(this.#db.prepare('DELETE FROM memories WHERE tenant_id = ? AND user_id = ?').run(tenantId, userId).changes);
  }

  #emit(event: AgentEvent) {
    for (const listener of this.#listeners) {
      // 一个订阅者（例如断开的 SSE 连接）出错，不影响其他订阅者，也不影响写入方
      try {
        listener(event);
      } catch (error) {
        console.error('event listener failed', error);
      }
    }
  }
}

function toRun(row: Row): Run {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    question: String(row.question),
    status: row.status as RunStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toMemory(row: Row): MemoryRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    key: String(row.key),
    content: String(row.content),
    sourceRunId: String(row.source_run_id),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  };
}

function toTicket(row: Row): Ticket {
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    draftId: String(row.draft_id),
    title: String(row.title),
    createdAt: String(row.created_at),
  };
}
