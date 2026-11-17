import { loadConfig } from './config.ts';
import { queueOptionsFromEnv, RunQueue } from './distributed/queue.ts';
import { createModel } from './llm/index.ts';
import { createGuardrails } from './guardrails/index.ts';
import { createLogger } from './logger.ts';
import { createMemory } from './memory.ts';
import { createSearch } from './retrieval/index.ts';
import { createApp } from './server.ts';
import { Store } from './store.ts';
import { createTelemetry } from './telemetry/index.ts';
import { createTools } from './tools/index.ts';

const config = loadConfig();
const logger = createLogger();
const store = new Store(config.databasePath);
const model = createModel(config);
const memory = config.memory ? createMemory(store) : undefined;
const tools = createTools(store, { search: createSearch(config), subagent: config.subagent ? { model } : undefined, memory });
// 第 22 章：设置了 OTEL_EXPORTER_OTLP_ENDPOINT 才启用追踪
const telemetry = createTelemetry(config, process.env, (message) => logger.error(message));
// 第 23 章：RUN_MODE=queue 时本进程只入队，run 由 npm run worker 启动的进程领取执行
const queue = config.runMode === 'queue' ? new RunQueue(store, queueOptionsFromEnv()) : undefined;
const app = createApp({
  store, model, tools, memory, guardrails: config.guardrails ? createGuardrails() : undefined, allowedOrigin: config.allowedOrigin, logger, demoLogin: config.demoLogin, telemetry: telemetry?.agent, queue,
});
if (telemetry) logger.info('tracing enabled', { sampleRatio: telemetry.agent.tracer.sampleRatio, captureContent: telemetry.agent.captureContent });
if (config.demoLogin && process.env.NODE_ENV === 'production') {
  logger.error('DEMO_LOGIN=true：任何人都能冒充任意员工，只能在受控内网演示时使用');
}

// 队列模式下崩溃恢复交给租约过期：没人续约的 run 会被 worker 重新领取
const recovered = queue ? 0 : app.recover();
app.server.listen(config.port, () => {
  logger.info('server started', { port: config.port, model: config.provider, recoveredRuns: recovered, runMode: config.runMode });
});

// 收到停止信号（Ctrl+C、docker stop）时优雅退出
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    logger.info('shutting down', { signal });
    await app.shutdown();
    await telemetry?.shutdown();
    store.close();
    process.exit(0);
  });
}
