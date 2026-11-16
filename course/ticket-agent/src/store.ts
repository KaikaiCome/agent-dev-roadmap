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
`;

type Row = Record<string, unknown>;

export class Store {
  #db: DatabaseSync;
  #listeners = new Set<(event: AgentEvent) => void>();
  #pending: AgentEvent[] | null = null;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);
  }

  close() {
    this.#db.close();
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

  createRun(user: User, question: string): Run {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.transaction(() => {
      this.#db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, user.tenantId, user.id, question, 'running', now, now);
      this.append(id, 'run_started', { question, userId: user.id });
    });
    return this.getRun(id)!;
  }

  getRun(id: string): Run | undefined {
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? toRun(row) : undefined;
  }

  runsWithStatus(status: RunStatus): Run[] {
    return (this.#db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY created_at').all(status) as Row[]).map(toRun);
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
