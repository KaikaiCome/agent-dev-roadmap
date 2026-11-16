import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { findUser } from '../src/data/seed.ts';
import { Store } from '../src/store.ts';
import { createTicketMcpServer } from './server.ts';

// 本地 MCP 服务：宿主（VS Code、Claude Desktop）启动这个进程，通过 stdin/stdout 交换 JSON-RPC。
// stdout 是协议通道，任何 console.log 都会破坏协议；日志只能写 stderr。
// 本地进程以“启动它的人”的身份运行，所以身份来自启动配置，而不是工具参数。

const user = findUser(process.env.MCP_USER ?? '');
if (!user) {
  console.error('请用 MCP_USER 指定员工（alice / carol / bob）');
  process.exit(1);
}

const store = new Store(process.env.DATABASE_PATH ?? fileURLToPath(new URL('../data/agent.db', import.meta.url)));
serveStdio(() => createTicketMcpServer({ store, user }));
console.error(`ticket-agent MCP (stdio) 已启动，当前员工：${user.name}`);
