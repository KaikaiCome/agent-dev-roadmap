import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { runAgent, SHUTDOWN, type AgentOptions } from '../agent.ts';
import { findUser, type User } from '../data/seed.ts';
import type { RunStatus } from '../events.ts';
import type { ChatModel } from '../llm/types.ts';
import { silentLogger, type Logger } from '../logger.ts';
import { isFenced, type Lease, type RunQueue } from './queue.ts';

// 第 23 章：worker 进程的主循环。领取 → 执行 → 按结果更新队列；执行期间定时续约，续约失败立刻中断。

/** 用这个 reason 中断 run，表示租约丢了（被别的 worker 接手或被取消） */
export const LEASE_LOST = 'lease_lost';

export type WorkerEvent =
  | { type: 'claimed'; lease: Lease }
  | { type: 'finished'; lease: Lease; status: RunStatus }
  | { type: 'fenced'; lease: Lease }
  | { type: 'error'; lease: Lease; error: string };

export interface WorkerOptions {
  queue: RunQueue;
  execute: (lease: Lease, signal: AbortSignal) => Promise<RunStatus>;
  /** 唯一标识这个 worker。缺省为 主机名:进程号:随机串 */
  owner?: string;
  /** 本进程同时执行几个 run */
  concurrency?: number;
  /** 队列为空时多久再看一次 */
  pollMs?: number;
  /** 续约间隔。要明显短于租约，留出几次续约失败的余量 */
  heartbeatMs?: number;
  logger?: Logger;
  onEvent?: (event: WorkerEvent) => void;
}

export class QueueWorker {
  readonly owner: string;
  #options: WorkerOptions;
  #inflight = new Map<string, { controller: AbortController; done: Promise<void> }>();
  #stopped = true;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: WorkerOptions) {
    this.#options = options;
    this.owner = options.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 6)}`;
  }

  start() {
    this.#stopped = false;
    this.#poll();
  }

  /** 停止领取新任务，中断执行中的 run（以 reason=shutdown 中断，run 保持 running 并放回队列），等它们收尾 */
  async stop(reason: unknown = SHUTDOWN) {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#inflight.forEach((entry) => entry.controller.abort(reason));
    await Promise.all([...this.#inflight.values()].map((entry) => entry.done));
  }

  get inflight() {
    return this.#inflight.size;
  }

  #poll() {
    if (this.#stopped) return;
    const { queue, concurrency = 4, pollMs = 200, logger = silentLogger } = this.#options;
    let claimed = false;
    try {
      while (this.#inflight.size < concurrency) {
        const lease = queue.claim(this.owner, this.#inflight.keys());
        if (!lease) break;
        claimed = true;
        this.#run(lease);
      }
    } catch (error) {
      logger.error('claim failed', { owner: this.owner, error: String(error) });
    }
    // 刚领到任务时马上再看一次（可能还有），否则等一会儿；抖动避免多个 worker 同时扫表
    this.#timer = setTimeout(() => this.#poll(), claimed ? 0 : pollMs * (0.5 + Math.random()));
  }

  #run(lease: Lease) {
    const { queue, execute, heartbeatMs = Math.max(Math.floor(queue.leaseMs / 3), 10), logger = silentLogger, onEvent } = this.#options;
    const controller = new AbortController();
    onEvent?.({ type: 'claimed', lease });
    logger.info('run claimed', { runId: lease.runId, owner: this.owner, fence: lease.fence, attempt: lease.attempt });
    const beat = setInterval(() => {
      try {
        if (!queue.heartbeat(lease)) controller.abort(LEASE_LOST);
      } catch (error) {
        logger.error('heartbeat failed', { runId: lease.runId, error: String(error) });
      }
    }, heartbeatMs);
    const entry = { controller, done: Promise.resolve() };
    this.#inflight.set(lease.runId, entry);
    entry.done = (async () => {
      try {
        const status = await execute(lease, controller.signal);
        queue.complete(lease, status);
        onEvent?.({ type: 'finished', lease, status });
        logger.info('run released', { runId: lease.runId, status, fence: lease.fence });
      } catch (error) {
        if (isFenced(error)) {
          // 不是错误，是栅栏在正常工作：我们卡住期间别人接手了，这里什么都不能再写
          onEvent?.({ type: 'fenced', lease });
          logger.info('stale worker fenced off', { runId: lease.runId, owner: this.owner, fence: lease.fence });
          return;
        }
        onEvent?.({ type: 'error', lease, error: String(error) });
        logger.error('run execution failed', { runId: lease.runId, error: String(error) });
        try {
          queue.fail(lease, String(error));
        } catch (failError) {
          if (!isFenced(failError)) logger.error('queue fail() failed', { runId: lease.runId, error: String(failError) });
        }
      } finally {
        clearInterval(beat);
        queue.forget(lease.runId);
        this.#inflight.delete(lease.runId);
      }
    })();
  }
}

/**
 * 工具调用 id 在一个 run 内必须唯一。离线 mock 模型用进程内计数器生成 id（mock_1、mock_2…），
 * 换了进程计数器从头开始，接手别人的 run 时会和日志里已有的 id 撞车。加上进程前缀解决；真实模型的 id 本来就是随机的
 */
export function uniqueCallIds(model: ChatModel, prefix = randomUUID().slice(0, 8)): ChatModel {
  return {
    name: model.name,
    async complete(request) {
      const response = await model.complete(request);
      const toolCalls = response.message.toolCalls?.map((call) => ({ ...call, id: `${prefix}_${call.id}` }));
      return toolCalls ? { ...response, message: { ...response.message, toolCalls } } : response;
    },
  };
}

/** 把领到的租约交给 Agent 执行。身份从目录里按 run 的 userId 查，绝不信任队列消息里的其他字段 */
export function agentExecutor(options: Omit<AgentOptions, 'onDelta'>, directory: (id: string) => User | undefined = findUser) {
  return (lease: Lease, signal: AbortSignal) => {
    const user = directory(lease.userId);
    if (!user) return Promise.reject(new Error(`用户 ${lease.userId} 不存在`));
    return runAgent(lease.runId, user, options, signal);
  };
}
