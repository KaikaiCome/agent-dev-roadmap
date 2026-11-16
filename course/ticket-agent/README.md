# ticket-agent：企业知识库与工单 Agent（参考实现）

这是 [Agent 精通路线](../../README.md) 实战教程配套的完整参考项目。教程网站 `#/learn` 的每一章都直接展示这里的源码，所以页面上的代码和这里可运行、有测试的代码始终一致。

员工可以用自然语言查询制度，Agent 只检索该员工有权限看的文档，并标注来源。员工也可以让 Agent 起草工单，确认后再提交。项目演示了这些能力：

- 多租户与文档权限
- 人工审批
- 幂等写入
- 事件日志与崩溃恢复
- SSE 推送与断线续传
- 评测门禁
- 容器部署

## 环境

- Node.js 24 或更高版本：原生运行 TypeScript，内置 `node:sqlite`。后端运行时没有第三方依赖，运行和测试都不需要 `npm install`；只有做类型检查（`npm run typecheck`）时才需要安装 `typescript` 和 `@types/node` 两个开发依赖。
- 默认使用离线 mock 模型，不需要 API Key。接入真实模型时，复制 `.env.example` 为 `.env`，然后修改其中的配置。
- 演示登录（选个名字就能登录）在开发环境默认开启；`NODE_ENV=production` 时默认关闭，服务会拒绝启动，必须接入 SSO，或在受控内网演示时显式设置 `DEMO_LOGIN=true`。

## 命令

```sh
npm test                       # 45 个后端测试（node:test，含高级篇）
npm install                    # 仅类型检查需要
npm run typecheck              # tsc 严格类型检查
npm run hello                  # 第 1 章：调用模型
npm run mini                   # 第 2 章：不到 70 行的最小 Agent
npm run bench                  # 第 17 章：检索基准，输出 recall@3
npm run replay -- <runId>      # 第 17 章：回放一次 run 的完整事件和发给模型的消息（加 --brief 只看每个事件的前 80 个字符）
npm run chat -- --user alice   # 命令行对话（含审批）
npm run eval                   # 评测门禁，不达标时退出码为 1
npm run server                 # HTTP + SSE 服务，默认端口 8787

cd web
npm install
npm run dev                    # React 工作台，/api 代理到 8787
```

演示用户：`alice`（Acme 普通员工）、`carol`（Acme 财务，可以看财务文档）、`bob`（Globex 员工）。他们能看到的文档和工单各不相同。

## 目录

| 路径 | 内容 | 教程章节 |
| --- | --- | --- |
| `src/llm/` | 消息类型、OpenAI 兼容流式适配器（重试、超时、取消）、离线模型 | 第 1 章 |
| `examples/` | 最小模型调用与最小 Agent 循环；检索基准与 run 回放 | 第 1–2、17 章 |
| `src/tools/knowledge.ts`、`src/data/seed.ts` | 先过滤权限、再检索的知识库 | 第 3 章 |
| `src/store.ts`、`src/agent.ts` | 事件日志、状态机、恢复 | 第 4 章 |
| `src/tools/tickets.ts` | 草稿、审批、幂等提交 | 第 5 章 |
| `src/server.ts`、`src/main.ts` | 会话、CSRF、限流、SSE、优雅退出 | 第 6 章 |
| `web/` | React 工作台 | 第 7 章 |
| `src/eval/` | 评测集与发布门禁 | 第 8 章 |
| `Dockerfile` | 容器化部署 | 第 10 章 |
| `mcp/` | MCP 服务：stdio 与 HTTP（OAuth Bearer）入口、确认、审计 | 第 12 章 |
| `src/context.ts` | 上下文预算与工具结果清除 | 第 13 章 |
| `src/eval/judge.ts` | LLM 评审、TPR/TNR 校准、偏差修正与置信区间 | 第 14 章 |
| `src/llm/fallback.ts`、`src/prompt.ts` | 模型降级与熔断、对缓存友好的提示词、只读工具并发 | 第 15 章 |

## MCP 服务（高级篇第 12 章）

`mcp/` 使用官方 TypeScript SDK，有自己的依赖，核心项目仍然零依赖。

```sh
cd mcp
npm ci
npm test                       # 9 个测试：权限、确认、幂等、审计、401、DNS 重绑定
npm run typecheck
MCP_USER=alice npm run stdio   # stdio 服务（PowerShell：$env:MCP_USER="alice"; npm run stdio）
MCP_DEMO_TOKENS=true npm run http   # HTTP 服务，默认端口 8788，演示 token：demo-alice / demo-carol / demo-bob
npm run inspect                # 用官方 Inspector 调试
```

## 演示与生产的边界

下面这些部分只是为了教学而做的简化。教程第 11 章会说明如何把它们替换成真实系统：

| 组件 | 演示实现 | 生产替换 |
| --- | --- | --- |
| 登录 | 选择演示用户 | 企业 SSO（OIDC） |
| 检索 | 关键词打分 | 向量或混合检索 |
| 存储 | 单机 SQLite | PostgreSQL 等数据库 |
| 运行 | 单进程执行 | 队列加多个 worker |
