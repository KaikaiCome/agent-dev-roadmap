import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  requireBearerAuth,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { findUser } from '../src/data/seed.ts';
import { Store } from '../src/store.ts';
import { createTicketMcpServer } from './server.ts';

export interface McpHttpOptions {
  store: Store;
  verifier: OAuthTokenVerifier;
  allowedHostnames?: string[];
  allowedOrigins?: string[];
}

/**
 * 远程 MCP 服务：一个 web 标准的 fetch 函数，Node、Deno、Cloudflare Workers 都能直接挂载。
 * 顺序很重要：Host/Origin 校验（防 DNS 重绑定）→ 认证 → 按调用者身份创建 MCP 实例。
 */
export function createMcpHttpApp({ store, verifier, allowedHostnames = localhostAllowedHostnames(), allowedOrigins = localhostAllowedOrigins() }: McpHttpOptions) {
  // 2026-07-28 版协议是无状态的：每个请求由工厂新建一个实例，身份在这里绑定，工具里拿不到也改不了
  const mcp = createMcpHandler(({ authInfo }) => {
    const user = findUser(String(authInfo?.extra?.userId));
    if (!user) throw new Error('未认证的请求不应到达 MCP 工厂');
    return createTicketMcpServer({ store, user });
  });
  const authenticate = requireBearerAuth({ verifier, requiredScopes: ['tickets'] });

  return {
    async fetch(request: Request): Promise<Response> {
      const rejected = hostHeaderValidationResponse(request, allowedHostnames) ?? originValidationResponse(request, allowedOrigins);
      if (rejected) return rejected;
      if (new URL(request.url).pathname !== '/mcp') return new Response('Not Found', { status: 404 });
      const auth = await authenticate(request);
      if (auth instanceof Response) return auth;
      return mcp.fetch(request, { authInfo: auth });
    },
    close: () => mcp.close(),
  };
}

/**
 * 演示用的令牌校验：固定 token 对应固定员工。
 * 生产环境换成校验企业 IdP 签发的 JWT（签名、过期时间、aud 必须是本服务），接口不变。
 */
export function demoTokenVerifier(tokens: Record<string, string>): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      const userId = tokens[token];
      if (!userId) throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token');
      // SDK 拒绝没有过期时间的 token：永不过期的凭证一旦泄露就无法止损
      return { token, clientId: 'demo', scopes: ['tickets'], expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { userId } };
    },
  };
}

export const DEMO_TOKENS: Record<string, string> = { 'demo-alice': 'alice', 'demo-carol': 'carol', 'demo-bob': 'bob' };

if (import.meta.main) {
  if (process.env.MCP_DEMO_TOKENS !== 'true') {
    console.error('请设置 MCP_DEMO_TOKENS=true 使用演示 token；生产环境请替换 demoTokenVerifier');
    process.exit(1);
  }
  const store = new Store(process.env.DATABASE_PATH ?? fileURLToPath(new URL('../data/agent.db', import.meta.url)));
  const app = createMcpHttpApp({ store, verifier: demoTokenVerifier(DEMO_TOKENS) });
  const port = Number(process.env.MCP_PORT ?? 8788);
  // 只监听本机。对外提供时放在网关后面，并把网关域名加入 allowedHostnames
  createServer(toNodeHandler(app)).listen(port, '127.0.0.1', () => {
    console.error(`MCP server: http://localhost:${port}/mcp （演示 token：${Object.keys(DEMO_TOKENS).join(' / ')}）`);
  });
}
