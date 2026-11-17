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
npm test                       # 120 个后端测试（node:test，含高级篇）
npm run verify                 # 本地验收：按章节运行测试和门禁，不达标退出码为 1（-- <章节id> 只验收部分，--list 列出章节）
npm install                    # 仅类型检查需要
npm run typecheck              # tsc 严格类型检查
npm run hello                  # 第 1 章：调用模型
npm run mini                   # 第 2 章：不到 70 行的最小 Agent
npm run bench                  # 第 17 章：检索基准，输出 recall@3
npm run bench:hybrid           # 第 18 章：关键词 / BM25 / 向量 / 混合检索对比（召回、拒答、越权）
npm run bench:memory           # 第 19 章：多会话记忆基准（无记忆 / 天真记忆 / 有策略的记忆）
npm run coding                 # 第 20 章：编码 Agent 在一次性副本上修 fixture 的 bug（-- --ask 逐次确认，-- --docker 用容器跑命令）
npm run redteam                # 第 21 章：按 OWASP LLM Top 10 分类的红队评测，对比开/关护栏的攻击得逞率；开护栏后仍有 critical 攻击得逞或误伤正常请求时退出码为 1
npm run slo                    # 第 22 章：从事件日志计算 SLO（成功率、p50/p95、每次 run 成本、错误预算燃烧率）；-- data/agent.db 用真实数据
npm run worker                 # 第 23 章：队列模式的 worker 进程（配合 RUN_MODE=queue npm run server，可以开多个）
npm run chaos                  # 第 23 章：双写对比 + 多进程混沌测试（随机 kill -9 / 冻结 worker），检查不丢不重；--no-fencing 关掉栅栏令牌对比
npm run eval:k                 # 第 24 章：每条用例跑 K 次（默认 5），报告 pass@k / pass^k / Wilson 区间；STOCHASTIC=v1 用随机扰动 mock，LLM_RECORD / LLM_REPLAY 录制回放
npm run structured             # 第 24 章：结构化输出的严格/宽松解析与修复循环对比（合格率、修复率、额外 token）
npm run train:data             # 第 25 章：从模拟日志导出 SFT / DPO 数据和质量报告，写入 data/training/
npm run train:compare          # 第 25 章：两个 mock 变体的前后对比评测（逐条修复/退化、显著性）
npm run replay -- <runId>      # 第 17 章：回放一次 run 的完整事件和发给模型的消息（加 --brief 只看每个事件的前 80 个字符）
npm run chat -- --user alice   # 命令行对话（含审批）
npm run eval                   # 评测门禁，不达标时退出码为 1（RETRIEVAL=hybrid 时用混合检索，SUBAGENT=on 时检索交给子 Agent）
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
| `examples/` | 最小模型调用与最小 Agent 循环；检索基准与 run 回放；混合检索基准；记忆基准；编码 Agent 演示；红队评测；SLO 计算；训练数据导出与模型前后对比 | 第 1–2、17、18、19、20、21、22、25 章 |
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
| `src/retrieval/` | 切块与入库筛查、BM25、embedding 接口、RRF 混合检索与重排序接口 | 第 18 章 |
| `src/subagent.ts`、`src/memory.ts`、`src/eval/memory.ts` | 只读调研子 Agent（独立 run、预算、取消、调用树）；按租户和员工隔离的长期记忆（写入策略、注入、删除）与多会话基准。`SUBAGENT=on`、`MEMORY=on` 开启 | 第 19 章 |
| `src/coding/`、`examples/fixtures/buggy-calc/` | 编码 Agent：工作区路径限制、按行读取、唯一匹配的搜索替换编辑、白名单命令（超时结束进程树、输出截断、环境变量清洗）、Node 权限模型与 Docker 方案；带 bug 的演示项目 | 第 20 章 |
| `src/guardrails/`、`src/redteam/` | 护栏：输入检查、工具调用策略（按角色默认拒绝、参数约束、次数上限、写操作需员工原话里的意图、外部地址白名单）、工具结果的指令筛查、输出过滤（外部链接与图片、PII 脱敏、金丝雀检测提示词泄露），`GUARDRAILS=on` 开启；照做注入指令的假模型与按 OWASP 分类的对抗用例 | 第 21 章 |
| `src/telemetry/` | 零依赖追踪：span、W3C traceparent 传播、有界队列的 OTLP/HTTP JSON 导出；按 OpenTelemetry GenAI 语义约定埋点（默认不记录内容）；从事件日志计算 SLO。设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 才开启 | 第 22 章 |
| `src/distributed/`、`src/worker.ts`、`examples/13-chaos.ts` | 持久化 run 队列（租约、心跳、过期接手、死信、按租户的并发与排队上限）；栅栏令牌（临时触发器拒绝过期持有者的写入）；事务性 outbox、投递器与消费端去重；worker 进程与混沌测试。`RUN_MODE=queue` 开启 | 第 23 章 |
| `src/reliability/`、`src/eval/passk.ts`、`src/eval/drift.ts`、`src/eval/run-k.ts`、`examples/fixtures/replay/`、`examples/fixtures/drift/` | 固定种子的随机扰动 mock；pass@k / pass^k、Wilson 区间与按 pass^k 的门禁；请求规范化与脱敏的录制回放；零依赖 JSON Schema 校验、工具参数与结构化输出的修复循环；快照对比与漂移检测。由 `STOCHASTIC`、`VALIDATE_TOOLS`、`LLM_RECORD`、`LLM_REPLAY` 等开启，不设置时行为不变 | 第 24 章 |
| `src/training/` | 从事件日志导出 OpenAI 格式的 SFT 数据（工具调用配对、稳定 id、脱敏、租户退出、注入/评测题/差评过滤、去重、按员工划分、质量报告）；DPO 偏好对；mock 变体与前后对比评测（逐条退化、McNemar 检验） | 第 25 章 |
| `frameworks/` | 用 OpenAI Agents SDK 与 LangGraph.js 重写核心流程，并与手写版逐字对比 | 第 26 章 |
| `python/` | Python 3.11+ 标准库移植：适配器、SSE、工具循环、权限检索、审批建单、SQLite、mock 模型、评测门禁 | 第 27 章 |
| `src/verify/` | 本地验收：按章节运行测试与门禁脚本，强制离线模型，可选子项目缺依赖时跳过（`npm run verify`） | 全部章节 |

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

## 框架对比（高级篇第 26 章）

`frameworks/` 用 `@openai/agents` 和 `@langchain/langgraph` 重写检索、需审批的建单和多轮对话，工具、权限、提示词和离线模型都直接复用 `../src`。依赖锁定精确版本，核心项目仍然零依赖。

```sh
cd frameworks
npm ci
npm test            # 11 个离线测试：权限过滤、拒答、审批中断与恢复、拒绝、重复恢复与检查点重放、多轮、流式
npm run demo        # 同一组对话交给手写版、Agents SDK、LangGraph，比较回答、模型调用、token 和工单数
npm run typecheck
```

## Python 版（高级篇第 27 章，可选）

`python/` 用 Python 3.11+ 标准库移植了核心（没有第三方依赖，不需要 `pip install`），与 TS 版共用 `.env`。它不在 `npm test` 里，没装 Python 不影响其他章节。

```sh
cd python
python -m unittest discover -s tests -t .   # 21 个测试（装了 Node 时会和 TS 版比对种子数据与评测用例）
python -m ticket_agent eval                 # 同样 8 条评测用例，mock 模型下 token 总量与 npm run eval 一致
python -m ticket_agent chat --user alice    # 命令行对话（含审批）
```

在仓库根目录也可以运行 `npm run test:python`。macOS / Linux 上如果 `python` 不是 Python 3，用 `python3`。没有移植的部分：HTTP 服务与前端、上下文裁剪、模型降级链、混合检索、MCP。

## 演示与生产的边界

下面这些部分只是为了教学而做的简化。教程第 11 章会说明如何把它们替换成真实系统：

| 组件 | 演示实现 | 生产替换 |
| --- | --- | --- |
| 登录 | 选择演示用户 | 企业 SSO（OIDC） |
| 检索 | 关键词打分 | 向量或混合检索 |
| 存储 | 单机 SQLite | PostgreSQL 等数据库 |
| 运行 | 单进程执行 | 队列加多个 worker |
