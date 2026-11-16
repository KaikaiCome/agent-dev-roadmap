// 结构化日志：一行一个 JSON，方便日志平台按 runId 检索和统计。
// 不记录完整的用户问题、文档正文和密钥，只记录排查需要的元数据。
export type Logger = {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

export function createLogger(options: { silent?: boolean } = {}): Logger {
  const write = (level: string, message: string, fields: Record<string, unknown> = {}) => {
    if (options.silent) return;
    process.stderr.write(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }) + '\n');
  };
  return {
    info: (message, fields) => write('info', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

export const silentLogger = createLogger({ silent: true });
