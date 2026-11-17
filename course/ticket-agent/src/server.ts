import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { cancelIdleRun, resolveApproval, runAgent, SHUTDOWN, usageOf, type AgentOptions } from './agent.ts';
import { findUser, users, type User } from './data/seed.ts';
import type { RunQueue } from './distributed/queue.ts';
import { terminalStatuses, type AgentEvent } from './events.ts';
import type { ChatModel } from './llm/types.ts';
import { silentLogger, type Logger } from './logger.ts';
import type { Memory } from './memory.ts';
import type { AgentTelemetry } from './telemetry/genai.ts';
import type { Store } from './store.ts';
import type { Tool } from './tools/types.ts';

export interface UserDirectory {
  find(id: string): User | undefined;
  list(): User[];
}

/** 演示用的用户目录。接入 SSO 后换成查询企业身份系统（见第 11 章） */
export const seedDirectory: UserDirectory = { find: findUser, list: () => users };

export interface AppOptions {
  store: Store;
  model: ChatModel;
  tools: Tool[];
  /** 允许调用 API 的前端地址，用于 CSRF 防护 */
  allowedOrigin: string;
  logger?: Logger;
  /** 每个用户同时执行中的 run 上限（包括审批后恢复执行的） */
  maxActiveRunsPerUser?: number;
  /** 每个用户最多有几个等待审批的 run，防止先攒一堆再集中批准 */
  maxWaitingRunsPerUser?: number;
  /** 每个用户最多同时打开几个事件流 */
  maxStreamsPerUser?: number;
  agent?: Pick<AgentOptions, 'maxSteps' | 'maxTokens' | 'maxOutputTokens' | 'approvalTtlMs'>;
  pingMs?: number;
  /** 是否开放演示登录（/api/users、/api/login） */
  demoLogin?: boolean;
  directory?: UserDirectory;
  /** 优雅退出最多等多久，超时后强制断开所有连接 */
  shutdownTimeoutMs?: number;
  /** 第 19 章：长期记忆。给出时 run 开始会注入记忆，并开放“我的记忆”查看和删除接口 */
  memory?: Memory;
  /** 第 21 章：护栏。缺省不启用 */
  guardrails?: AgentOptions['guardrails'];
  /** 第 22 章：OpenTelemetry 追踪。缺省不追踪 */
  telemetry?: AgentTelemetry;
  /** 第 23 章：给出时 run 不在本进程执行，而是写进持久队列，由 worker 进程领取 */
  queue?: RunQueue;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY_BYTES = 16 * 1024;
/** 慢客户端积压超过这个字节数就断开，让它带 Last-Event-ID 重连补发，避免服务端内存无限增长 */
const MAX_STREAM_BUFFER = 256 * 1024;

export function createApp(options: AppOptions) {
  const {
    store, model, tools, allowedOrigin, logger = silentLogger,
    maxActiveRunsPerUser = 2, maxWaitingRunsPerUser = 5, maxStreamsPerUser = 5, pingMs = 15_000,
    demoLogin = true, directory = seedDirectory, shutdownTimeoutMs = 10_000,
  } = options;
  // 演示用的内存会话。生产环境换成 SSO + 服务端会话存储（如 Redis）
  const sessions = new Map<string, string>();
  const active = new Map<string, { controller: AbortController; userId: string }>();
  const streams = new Map<() => void, string>();
  const deltaListeners = new Set<(runId: string, text: string) => void>();
  let draining = false;

  const activeCount = (userId: string) => [...active.values()].filter((entry) => entry.userId === userId).length;

  /** 在后台执行 run。HTTP 请求立即返回，进度通过 SSE 推送。traceparent 是触发这次执行的请求带来的上游 trace（第 22 章） */
  function start(runId: string, user: User, traceparent?: string | string[]) {
    if (options.queue || active.has(runId) || draining) return;
    const controller = new AbortController();
    active.set(runId, { controller, userId: user.id });
    const { telemetry } = options;
    const execute = () => runAgent(runId, user, {
      ...options.agent,
      model, store, tools, logger, memory: options.memory, telemetry, guardrails: options.guardrails,
      onDelta: (id, text) => deltaListeners.forEach((listener) => listener(id, text)),
    }, controller.signal);
    (telemetry ? telemetry.continueFrom(traceparent, execute) : execute())
      .catch((error) => logger.error('run crashed', { runId, error: String(error) }))
      .finally(() => active.delete(runId));
  }

  function currentUser(req: IncomingMessage): User {
    const sid = parseCookies(req.headers.cookie).sid;
    const user = sid ? directory.find(sessions.get(sid) ?? '') : undefined;
    if (!user) throw new HttpError(401, '请先登录');
    return user;
  }

  /** 别人的 run 一律返回 404，而不是 403，避免泄露“这个 ID 存在” */
  function ownRun(runId: string, user: User) {
    const run = store.getRun(runId);
    if (!run || run.userId !== user.id || run.tenantId !== user.tenantId) throw new HttpError(404, 'run 不存在');
    return run;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean);

    // CSRF 防护：所有写请求必须是 JSON，且来自允许的前端地址
    if (method === 'POST' || method === 'DELETE') {
      const origin = req.headers.origin;
      if (origin && origin !== allowedOrigin) throw new HttpError(403, '不允许的来源');
    }
    if (method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请求体必须是 JSON');
    }

    if (method === 'GET' && url.pathname === '/api/health') return json(res, draining ? 503 : 200, { ok: !draining });

    if (demoLogin && method === 'GET' && url.pathname === '/api/users') {
      return json(res, 200, directory.list().map(({ id, name }) => ({ id, name })));
    }

    if (demoLogin && method === 'POST' && url.pathname === '/api/login') {
      const body = await readJson(req);
      const user = directory.find(typeof body.userId === 'string' ? body.userId : '');
      if (!user) throw new HttpError(400, '未知用户');
      const sid = randomUUID();
      sessions.set(sid, user.id);
      // HttpOnly：前端 JS 读不到，XSS 偷不走；SameSite=Lax：跨站 POST 不会带上
      res.setHeader('set-cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);
      return json(res, 200, publicUser(user));
    }

    const user = currentUser(req);

    if (method === 'GET' && url.pathname === '/api/me') return json(res, 200, publicUser(user));

    // 第 19 章：员工能看到 Agent 记住了自己什么，并能逐条或全部删除。只能操作自己的记忆
    if (options.memory && parts[0] === 'api' && parts[1] === 'memories' && parts.length <= 3) {
      if (method === 'GET' && !parts[2]) return json(res, 200, store.memories(user.tenantId, user.id));
      if (method === 'DELETE' && parts[2]) {
        if (!store.deleteMemory(user.tenantId, user.id, parts[2])) throw new HttpError(404, '记忆不存在');
        logger.info('memory deleted', { userId: user.id, tenantId: user.tenantId, memoryId: parts[2] });
        return json(res, 200, { deleted: 1 });
      }
      if (method === 'DELETE') {
        const deleted = store.deleteMemories(user.tenantId, user.id);
        logger.info('memories erased', { userId: user.id, tenantId: user.tenantId, deleted });
        return json(res, 200, { deleted });
      }
    }

    if (method === 'POST' && url.pathname === '/api/runs') {
      if (draining) throw new HttpError(503, '服务正在重启，请稍后再试');
      const body = await readJson(req);
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      if (!question || question.length > 2000) throw new HttpError(400, '问题不能为空，且不能超过 2000 字');
      if (activeCount(user.id) >= maxActiveRunsPerUser) throw new HttpError(429, '同时进行的任务太多，请稍后再试');
      const waiting = store.runsWithStatus('waiting_approval').filter((r) => r.userId === user.id && r.tenantId === user.tenantId).length;
      if (waiting >= maxWaitingRunsPerUser) throw new HttpError(429, '待确认的任务太多，请先处理或取消');
      // 队列模式：建 run 和入队在同一个事务里；租户排队数超限时拒绝（背压）
      const submitted = options.queue ? options.queue.submit(user, question) : { ok: true as const, run: store.createRun(user, question) };
      if (!submitted.ok) throw new HttpError(429, submitted.message);
      const { run } = submitted;
      logger.info('run created', { runId: run.id, userId: user.id, tenantId: user.tenantId });
      start(run.id, user, req.headers.traceparent);
      return json(res, 201, { runId: run.id });
    }

    if (parts[0] === 'api' && parts[1] === 'runs' && parts[2]) {
      const run = ownRun(parts[2], user);
      const action = parts[3];

      if (method === 'GET' && !action) return json(res, 200, { run, usage: usageOf(store.events(run.id)) });

      if (method === 'GET' && action === 'events') return streamEvents(req, res, url, run.id, user.id);

      if (method === 'POST' && action === 'approvals') {
        if (draining) throw new HttpError(503, '服务正在重启，请稍后再试');
        const body = await readJson(req);
        if (typeof body.callId !== 'string' || typeof body.approved !== 'boolean') throw new HttpError(400, '需要 callId 和 approved');
        // 批准后 run 会恢复执行，同样要受并发上限约束
        if (activeCount(user.id) >= maxActiveRunsPerUser) throw new HttpError(429, '同时进行的任务太多，请稍后再试');
        const decide = () => resolveApproval(store, run.id, user, body.callId as string, body.approved as boolean);
        const result = options.queue ? options.queue.resumeAfter(run.id, decide) : decide();
        if (!result.ok) throw new HttpError(result.code === 'NOT_FOUND' ? 404 : 409, result.code);
        logger.info('approval resolved', { runId: run.id, callId: body.callId, approved: result.approved, userId: user.id });
        start(run.id, user, req.headers.traceparent);
        return json(res, 200, result);
      }

      if (method === 'POST' && action === 'cancel') {
        const entry = active.get(run.id);
        if (entry) entry.controller.abort();
        else if (!(options.queue ? options.queue.cancel(run.id) : cancelIdleRun(store, run.id))) throw new HttpError(409, 'run 已结束');
        return json(res, 202, { ok: true });
      }
    }

    throw new HttpError(404, '接口不存在');
  }

  /**
   * SSE 推送事件。先订阅、再补发历史，用 seq 去重，这样补发和实时之间不会漏事件。
   * 浏览器断线重连时会自动带上 Last-Event-ID，我们从那之后继续发。
   */
  function streamEvents(req: IncomingMessage, res: ServerResponse, url: URL, runId: string, userId: string) {
    const open = [...streams.values()].filter((owner) => owner === userId).length;
    if (open >= maxStreamsPerUser) throw new HttpError(429, '打开的事件流太多');
    const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0) || 0;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 告诉 nginx 不要缓冲，否则用户要等整段结束才看到输出
      'x-accel-buffering': 'no',
    });
    let lastSeq = after;
    let closed = false;
    const write = (chunk: string) => {
      res.write(chunk);
      if (res.writableLength > MAX_STREAM_BUFFER) close();
    };
    const send = (event: AgentEvent) => {
      if (closed || event.runId !== runId || event.seq <= lastSeq) return;
      lastSeq = event.seq;
      write(`id: ${event.seq}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'run_finished') close();
    };
    const sendDelta = (id: string, text: string) => {
      if (!closed && id === runId) write(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`);
    };
    const unsubscribe = store.onEvent(send);
    deltaListeners.add(sendDelta);
    const ping = setInterval(() => write(': ping\n\n'), pingMs);
    // 队列模式下事件由别的进程写入，本进程收不到通知，只能轮询数据库（生产环境用 LISTEN/NOTIFY 或消息总线）
    const poll = options.queue ? setInterval(() => store.events(runId, lastSeq).forEach(send), 300) : undefined;
    function close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      deltaListeners.delete(sendDelta);
      streams.delete(close);
      clearInterval(ping);
      clearInterval(poll);
      res.end();
    }
    streams.set(close, userId);
    req.on('close', close);

    store.events(runId, after).forEach(send);
    const run = store.getRun(runId);
    if (run && terminalStatuses.includes(run.status)) close();
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) return res.end();
      if (error instanceof HttpError) return json(res, error.status, { error: error.message });
      logger.error('request failed', { method: req.method, url: req.url, error: String(error) });
      json(res, 500, { error: '服务器内部错误' });
    });
  });

  return {
    server,
    /** 进程重启后，继续执行上次没跑完的 run。事件日志保证不会重复执行已完成的步骤 */
    recover() {
      const runs = store.runsWithStatus('running');
      for (const run of runs) {
        const owner = directory.find(run.userId);
        if (owner) start(run.id, owner);
        else logger.error('run owner not found, skipped', { runId: run.id, userId: run.userId });
      }
      return runs.length;
    },
    /**
     * 优雅退出：先停止接新任务，再中断执行中的 run（保持 running 状态，下次启动时 recover() 会继续），
     * 关闭所有事件流（浏览器会自动重连到新进程），最后关闭服务。整个过程有超时上限。
     */
    async shutdown() {
      draining = true;
      active.forEach((entry) => entry.controller.abort(SHUTDOWN));
      [...streams.keys()].forEach((close) => close());
      const deadline = Date.now() + shutdownTimeoutMs;
      while (active.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      const timer = setTimeout(() => server.closeAllConnections(), Math.max(deadline - Date.now(), 0));
      await closed;
      clearTimeout(timer);
    },
    activeRuns: () => active.size,
  };
}

function publicUser(user: User) {
  return { id: user.id, name: user.name, tenantId: user.tenantId, roles: user.roles };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function parseCookies(header = ''): Record<string, string> {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=')).filter(([key]) => key));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON 对象');
  }
}
