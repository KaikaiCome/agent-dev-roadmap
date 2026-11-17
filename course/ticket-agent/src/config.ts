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
  /** keyword = 第 3 章的关键词检索；hybrid = 第 18 章的 BM25 + 向量混合检索 */
  retrieval: 'keyword' | 'hybrid';
  embedding: { provider: 'mock' | 'openai'; baseURL: string; apiKey: string; model: string; minSimilarity: number };
  /** 第 19 章：on = 检索交给只读的调研子 Agent */
  subagent: boolean;
  /** 第 19 章：on = 启用长期记忆（remember 工具 + run 开始时注入记忆） */
  memory: boolean;
  /** 第 21 章：on = 启用护栏（输入检查、工具调用策略、工具结果筛查、输出过滤） */
  guardrails: boolean;
  /** 第 23 章：inline = API 进程自己执行 run（默认）；queue = 只入队，由 npm run worker 启动的进程执行 */
  runMode: 'inline' | 'queue';
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
    retrieval: env.RETRIEVAL === 'hybrid' ? 'hybrid' : 'keyword',
    embedding: {
      provider: env.EMBEDDING_PROVIDER === 'openai' ? 'openai' : 'mock',
      // 很多服务的对话模型和 embedding 模型不在同一家（例如 DeepSeek 没有 embedding 接口），所以单独配置
      baseURL: (env.EMBEDDING_BASE_URL ?? env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: env.EMBEDDING_API_KEY ?? env.LLM_API_KEY ?? '',
      model: env.EMBEDDING_MODEL ?? '',
      // 向量一路的相关门槛，不同模型的相似度分布差别很大，换模型后用 npm run bench:hybrid 重新校准
      minSimilarity: Number(env.EMBEDDING_MIN_SIMILARITY ?? 0.5),
    },
    subagent: onOff(env, 'SUBAGENT'),
    memory: onOff(env, 'MEMORY'),
    guardrails: onOff(env, 'GUARDRAILS'),
    runMode: env.RUN_MODE === 'queue' ? 'queue' : 'inline',
  };
  if (env.RUN_MODE && env.RUN_MODE !== 'inline' && env.RUN_MODE !== 'queue') {
    throw new Error(`RUN_MODE 只能是 inline 或 queue，当前是 ${env.RUN_MODE}`);
  }
  if (env.RETRIEVAL && env.RETRIEVAL !== 'keyword' && env.RETRIEVAL !== 'hybrid') {
    throw new Error(`RETRIEVAL 只能是 keyword 或 hybrid，当前是 ${env.RETRIEVAL}`);
  }
  if (config.embedding.provider === 'openai' && (!config.embedding.apiKey || !config.embedding.model)) {
    throw new Error('EMBEDDING_PROVIDER=openai 时必须设置 EMBEDDING_API_KEY（或 LLM_API_KEY）和 EMBEDDING_MODEL');
  }
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

function onOff(env: Record<string, string | undefined>, name: string): boolean {
  const value = env[name] ?? 'off';
  if (value !== 'on' && value !== 'off') throw new Error(`${name} 只能是 on 或 off，当前是 ${value}`);
  return value === 'on';
}
