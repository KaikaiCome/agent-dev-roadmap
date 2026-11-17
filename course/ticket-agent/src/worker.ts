import { loadConfig } from './config.ts';
import { Inbox, Outbox, startDispatcher, webhookDelivery, withTicketOutbox, type Deliver } from './distributed/outbox.ts';
import { queueOptionsFromEnv, RunQueue } from './distributed/queue.ts';
import { agentExecutor, QueueWorker, uniqueCallIds } from './distributed/worker.ts';
import { createGuardrails } from './guardrails/index.ts';
import { createModel } from './llm/index.ts';
import { createLogger } from './logger.ts';
import { createMemory } from './memory.ts';
import { createSearch } from './retrieval/index.ts';
import { Store } from './store.ts';
import { createTelemetry } from './telemetry/index.ts';
import { createTools } from './tools/index.ts';

// 第 23 章：worker 进程。和 RUN_MODE=queue 的 API 进程共享同一个数据库文件，可以启动任意多个。
// 每个进程领取并执行 run，同时投递 outbox 里的消息（WEBHOOK_URL 未设置时投递到本地的演示收件箱）

const config = loadConfig();
const logger = createLogger();
const store = new Store(config.databasePath);
const queue = new RunQueue(store, queueOptionsFromEnv());
const outbox = new Outbox(store);
const model = uniqueCallIds(createModel(config));
const memory = config.memory ? createMemory(store) : undefined;
const tools = withTicketOutbox(createTools(store, { search: createSearch(config), subagent: config.subagent ? { model } : undefined, memory }), outbox);
const telemetry = createTelemetry(config, process.env, (message) => logger.error(message));

const worker = new QueueWorker({
  queue,
  execute: agentExecutor({ model, store, tools, memory, logger, guardrails: config.guardrails ? createGuardrails() : undefined, telemetry: telemetry?.agent }),
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  logger,
});

let deliver: Deliver;
if (process.env.WEBHOOK_URL) {
  deliver = webhookDelivery(process.env.WEBHOOK_URL);
} else {
  const inbox = new Inbox(config.databasePath.replace(/\.db$/, '') + '-inbox.db');
  deliver = async (message) => {
    logger.info('notification delivered', { key: message.key, result: inbox.receive(message) });
  };
}
const dispatcher = startDispatcher(outbox, worker.owner, deliver, { onError: (error) => logger.error('dispatch failed', { error: String(error) }) });

worker.start();
logger.info('worker started', { owner: worker.owner, leaseMs: queue.leaseMs, model: config.provider });
const metrics = setInterval(() => logger.info('queue stats', { ...queue.stats(), outbox: outbox.stats() }), 30_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    logger.info('worker stopping', { signal, inflight: worker.inflight });
    clearInterval(metrics);
    // 中断执行中的 run 并放回队列（不消耗重试次数），别的 worker 会立刻接手
    await worker.stop();
    await dispatcher.stop();
    await telemetry?.shutdown();
    store.close();
    process.exit(0);
  });
}
