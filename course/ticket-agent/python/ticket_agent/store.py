from __future__ import annotations

import json
import sqlite3
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .seed import User
from .types import dumps

# 对应 src/store.ts。表结构与 TS 版相同，事件 data 的字段名也保持 camelCase。
#
# sqlite3 连接默认只能在创建它的线程里使用（check_same_thread=True）。
# 本项目所有数据库操作都在事件循环线程里同步执行：单次写入是微秒级的本地操作，
# 放进 asyncio.to_thread 反而会跨线程使用连接。数据库换成远程 PostgreSQL 时，必须改用异步驱动。

SCHEMA = """
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
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""


@dataclass(frozen=True)
class Run:
    id: str
    tenant_id: str
    user_id: str
    question: str
    status: str
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class Event:
    run_id: str
    seq: int
    type: str
    data: dict[str, Any]
    created_at: str


@dataclass(frozen=True)
class Draft:
    id: str
    run_id: str
    tenant_id: str
    user_id: str
    title: str
    description: str
    source_ids: list[str]


@dataclass(frozen=True)
class Ticket:
    id: str
    idempotency_key: str
    tenant_id: str
    user_id: str
    draft_id: str
    title: str
    created_at: str


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class Store:
    def __init__(self, path: str = ':memory:') -> None:
        if path != ':memory:':
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # isolation_level=None：关闭 sqlite3 模块的隐式事务，由 transaction() 显式 BEGIN/COMMIT，语义与 node:sqlite 一致
        self._db = sqlite3.connect(path, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.executescript('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;' + SCHEMA)
        self._listeners: list[Callable[[Event], None]] = []
        self._pending: list[Event] | None = None

    def close(self) -> None:
        self._db.close()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """多条写入要么全部成功、要么全部回滚。事件在提交成功后才通知订阅者。嵌套使用并入外层事务。"""
        if self._pending is not None:
            yield
            return
        self._db.execute('BEGIN IMMEDIATE')
        self._pending = []
        try:
            yield
            self._db.execute('COMMIT')
            committed = self._pending
        except BaseException:
            self._db.execute('ROLLBACK')
            raise
        finally:
            self._pending = None
        for event in committed:
            self._emit(event)

    def create_run(self, user: User, question: str) -> Run:
        run_id = str(uuid.uuid4())
        now = now_iso()
        with self.transaction():
            self._db.execute('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)', (run_id, user.tenant_id, user.id, question, 'running', now, now))
            self.append(run_id, 'run_started', {'question': question, 'userId': user.id})
        run = self.get_run(run_id)
        assert run is not None
        return run

    def get_run(self, run_id: str) -> Run | None:
        row = self._db.execute('SELECT * FROM runs WHERE id = ?', (run_id,)).fetchone()
        return Run(*row) if row else None

    def runs_with_status(self, status: str) -> list[Run]:
        return [Run(*row) for row in self._db.execute('SELECT * FROM runs WHERE status = ? ORDER BY created_at', (status,))]

    def set_status(self, run_id: str, status: str) -> None:
        self._db.execute('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?', (status, now_iso(), run_id))

    def append(self, run_id: str, type: str, data: dict[str, Any]) -> Event:
        """追加一条事件，序号由数据库在同一条 SQL 里分配，保证每个 run 内连续递增。"""
        created_at = now_iso()
        row = self._db.execute(
            """INSERT INTO events (run_id, seq, type, data, created_at)
               SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ? FROM events WHERE run_id = ?
               RETURNING seq""",
            (run_id, type, dumps(data), created_at, run_id),
        ).fetchone()
        event = Event(run_id, row['seq'], type, data, created_at)
        if self._pending is not None:
            self._pending.append(event)
        else:
            self._emit(event)
        return event

    def events(self, run_id: str, after_seq: int = 0) -> list[Event]:
        rows = self._db.execute('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq', (run_id, after_seq))
        return [Event(row['run_id'], row['seq'], row['type'], json.loads(row['data']), row['created_at']) for row in rows]

    def on_event(self, listener: Callable[[Event], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def save_draft(self, run_id: str, tenant_id: str, user_id: str, title: str, description: str, source_ids: list[str]) -> Draft:
        draft = Draft(f'draft_{str(uuid.uuid4())[:8]}', run_id, tenant_id, user_id, title, description, source_ids)
        self._db.execute('INSERT INTO drafts VALUES (?, ?, ?, ?, ?, ?, ?)',
                         (draft.id, run_id, tenant_id, user_id, title, description, dumps(source_ids)))
        return draft

    def get_draft(self, draft_id: str) -> Draft | None:
        row = self._db.execute('SELECT * FROM drafts WHERE id = ?', (draft_id,)).fetchone()
        if not row:
            return None
        return Draft(row['id'], row['run_id'], row['tenant_id'], row['user_id'], row['title'], row['description'], json.loads(row['source_ids']))

    def create_ticket_once(self, idempotency_key: str, tenant_id: str, user_id: str, draft_id: str, title: str) -> tuple[Ticket, bool]:
        """幂等创建：同一个 key 无论调用多少次，只会产生一张工单。返回 (工单, 是否新建)。"""
        with self.transaction():
            existing = self._db.execute('SELECT * FROM tickets WHERE idempotency_key = ?', (idempotency_key,)).fetchone()
            if existing:
                return Ticket(*existing), False
            ticket = Ticket(f'TCK-{_base36(int(time.time() * 1000))}-{str(uuid.uuid4())[:4]}',
                            idempotency_key, tenant_id, user_id, draft_id, title, now_iso())
            self._db.execute('INSERT INTO tickets VALUES (?, ?, ?, ?, ?, ?, ?)', (
                ticket.id, ticket.idempotency_key, ticket.tenant_id, ticket.user_id, ticket.draft_id, ticket.title, ticket.created_at))
            return ticket, True

    def tickets(self, tenant_id: str) -> list[Ticket]:
        return [Ticket(*row) for row in self._db.execute('SELECT * FROM tickets WHERE tenant_id = ? ORDER BY created_at', (tenant_id,))]

    def _emit(self, event: Event) -> None:
        for listener in list(self._listeners):
            # 一个订阅者出错，不影响其他订阅者，也不影响写入方
            try:
                listener(event)
            except Exception as error:  # noqa: BLE001
                print('event listener failed', error)


def _base36(value: int) -> str:
    digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    out = ''
    while value:
        value, rest = divmod(value, 36)
        out = digits[rest] + out
    return out or '0'
