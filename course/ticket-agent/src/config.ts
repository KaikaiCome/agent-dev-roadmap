// 所有配置只从服务端环境变量读取。密钥永远不进入前端代码。
export interface Config {
  provider: 'mock' | 'openai';
  baseURL: string;
  apiKey: string;
  model: string;
  priceInputPerMTok: number;
  priceOutputPerMTok: number;
  port: number;
  databasePath: string;
  allowedOrigin: string;
  /** 演示登录：选一个用户名就能登录。只能用于本地学习，生产必须接入企业 SSO */
  demoLogin: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const provider = env.MODEL_PROVIDER ?? 'mock';
  if (provider !== 'mock' && provider !== 'openai') {
    throw new Error(`MODEL_PROVIDER 只能是 mock 或 openai，当前是 ${provider}`);
  }
  const config: Config = {
    provider,
    baseURL: (env.LLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey: env.LLM_API_KEY ?? '',
    model: env.LLM_MODEL ?? 'deepseek-chat',
    priceInputPerMTok: Number(env.LLM_PRICE_INPUT ?? 0),
    priceOutputPerMTok: Number(env.LLM_PRICE_OUTPUT ?? 0),
    port: Number(env.PORT ?? 8787),
    databasePath: env.DATABASE_PATH ?? './data/agent.db',
    allowedOrigin: env.ALLOWED_ORIGIN ?? 'http://localhost:5173',
    demoLogin: env.DEMO_LOGIN === 'true' || (env.NODE_ENV !== 'production' && env.DEMO_LOGIN !== 'false'),
  };
  // 启动时就失败，比运行到一半才报 401 更容易排查
  if (provider === 'openai' && !config.apiKey) {
    throw new Error('MODEL_PROVIDER=openai 时必须设置 LLM_API_KEY');
  }
  // 演示登录谁都能冒充任何员工。生产环境默认拒绝启动，避免误把它暴露到公网
  if (env.NODE_ENV === 'production' && !config.demoLogin) {
    throw new Error('生产环境必须接入企业 SSO（见教程第 11 章）。仅在受控内网演示时可设置 DEMO_LOGIN=true');
  }
  return config;
}
