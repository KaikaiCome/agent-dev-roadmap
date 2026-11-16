import { loadConfig } from './config.ts';
import { createModel } from './llm/index.ts';
import { createLogger } from './logger.ts';
import { createApp } from './server.ts';
import { Store } from './store.ts';
import { createTools } from './tools/index.ts';

const config = loadConfig();
const logger = createLogger();
const store = new Store(config.databasePath);
const app = createApp({
  store, model: createModel(config), tools: createTools(store), allowedOrigin: config.allowedOrigin, logger, demoLogin: config.demoLogin,
});
if (config.demoLogin && process.env.NODE_ENV === 'production') {
  logger.error('DEMO_LOGIN=true：任何人都能冒充任意员工，只能在受控内网演示时使用');
}

const recovered = app.recover();
app.server.listen(config.port, () => {
  logger.info('server started', { port: config.port, model: config.provider, recoveredRuns: recovered });
});

// 收到停止信号（Ctrl+C、docker stop）时优雅退出
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    logger.info('shutting down', { signal });
    await app.shutdown();
    store.close();
    process.exit(0);
  });
}
