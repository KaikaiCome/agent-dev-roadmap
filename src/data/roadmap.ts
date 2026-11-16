export interface Resource {
  title: string;
  url: string;
  note?: string;
}

export interface Task {
  /** Stable key for persisted progress; never reuse a removed id. */
  id: string;
  text: string;
  detail?: string;
}

export interface TaskGroup {
  title: string;
  tasks: Task[];
}

export interface Stage {
  id: string;
  index: number;
  title: string;
  weeks: string;
  goal: string;
  groups: TaskGroup[];
  deliverable: string;
  resources: Resource[];
  snippetId?: string;
}

export const pillars = [
  { title: '循环与状态', text: '模型请求 → 工具调用 → 回填结果 → 继续请求，以及取消、重试和中断后恢复。' },
  { title: '上下文工程', text: '每一轮让模型看到什么：提示词、工具 schema、历史、压缩与外部记忆。' },
  { title: '工具设计', text: '工具 schema 是写给模型的 API，名称、描述、参数和错误信息决定调用成功率。' },
  { title: '可靠性与安全', text: '审批、沙箱、权限、成本控制与失败恢复。' },
  { title: '评估（eval）', text: '用数据证明改动有效，而不是凭感觉判断。最能区分新手和熟手。' },
];

export const stages: Stage[] = [
  {
    id: 'intuition',
    index: 0,
    title: '建立直觉',
    weeks: '第 1–2 周',
    goal: '先作为用户大量使用 Agent，再弄清 LLM API 的基本机制。',
    groups: [
      {
        title: '作为用户观察',
        tasks: [
          { id: 's0-daily-use', text: '每天用 Claude Code、Codex CLI 或 Cursor Agent 完成一个真实任务' },
          { id: 's0-observe', text: '观察 Agent 何时规划、何时调用工具、何时请求审批、在哪里失败' },
        ],
      },
      {
        title: '直接调用 LLM API',
        tasks: [
          { id: 's0-roles', text: '理解 system / user / assistant / tool 四种消息角色' },
          { id: 's0-stream', text: '实现一次 SSE 流式输出并逐块打印' },
          { id: 's0-tool-schema', text: '用 JSON schema 定义一个工具，并让模型调用它' },
          { id: 's0-tokens', text: '弄清 token 计费与上下文窗口限制' },
        ],
      },
      {
        title: '概念',
        tasks: [
          { id: 's0-read-bea', text: '阅读 Building Effective Agents，分清 workflow 与 agent', detail: 'workflow 由代码编排固定路径；agent 由模型动态决定下一步。' },
        ],
      },
    ],
    deliverable: '一份笔记：记录 10 个你观察到的 Agent 失败案例及原因分析。',
    resources: [
      { title: 'Building Effective Agents', url: 'https://www.anthropic.com/engineering/building-effective-agents' },
      { title: 'OpenAI Function calling', url: 'https://platform.openai.com/docs/guides/function-calling' },
      { title: 'DeepSeek API 文档', url: 'https://api-docs.deepseek.com/zh-cn/' },
    ],
  },
  {
    id: 'from-scratch',
    index: 1,
    title: '从零手写一个 Agent',
    weeks: '第 3–5 周',
    goal: '不用框架，用 TypeScript/Node 手写一个最小的 coding agent。这是整个规划中最关键的一步。',
    groups: [
      {
        title: 'Agent 循环',
        tasks: [
          { id: 's1-loop', text: '实现循环：请求 → 解析 tool_calls → 执行 → 回填 → 继续，直到模型不再调用工具' },
          { id: 's1-max-steps', text: '限制最大步数，防止无限循环' },
        ],
      },
      {
        title: '工具',
        tasks: [
          { id: 's1-tools', text: '实现 read_file、write_file、list_dir、bash 四个工具' },
          { id: 's1-approval', text: 'bash 执行前请求用户确认' },
          { id: 's1-tool-errors', text: '工具出错时把错误回传给模型，而不是让程序崩溃' },
          { id: 's1-parallel', text: '并行执行同一步中的多个工具调用' },
        ],
      },
      {
        title: '可靠性与持久化',
        tasks: [
          { id: 's1-abort', text: '用 AbortController 支持取消正在进行的请求' },
          { id: 's1-event-log', text: '把会话保存为只追加的 JSONL 事件日志' },
          { id: 's1-derive', text: '每次请求的历史都从事件日志推导出来', detail: '日志是唯一事实来源：模型看到的内容必须能从日志重建。' },
          { id: 's1-resume-fork', text: '支持恢复会话，以及从某一轮 fork' },
        ],
      },
    ],
    deliverable: '一个 500–800 行的 CLI agent，能完成“读代码 → 修改 → 跑测试”这类简单任务。',
    resources: [
      { title: 'OpenAI Node SDK', url: 'https://github.com/openai/openai-node' },
      { title: 'MDN: AbortController', url: 'https://developer.mozilla.org/docs/Web/API/AbortController' },
    ],
    snippetId: 'agent-loop',
  },
  {
    id: 'agent-ui',
    index: 2,
    title: '发挥 React 优势，做 Agent 界面',
    weeks: '第 6–8 周',
    goal: '给阶段 1 的 agent 加上 Web UI，掌握 Agent 前端的常见模式。',
    groups: [
      {
        title: '事件驱动的状态',
        tasks: [
          { id: 's2-transport', text: '后端用 SSE 或 WebSocket 推送 agent 事件' },
          { id: 's2-reducer', text: '前端把事件流 reduce 成 UI 状态（如 Zustand + Immer）' },
          { id: 's2-reconnect', text: '断线重连后从最后事件序号恢复事件流' },
        ],
      },
      {
        title: 'UI 模式',
        tasks: [
          { id: 's2-markdown', text: '流式渲染 Markdown 与代码块，处理增量 token 的闪烁和性能' },
          { id: 's2-tool-card', text: '工具调用卡片：进行中 / 成功 / 失败状态，可展开参数和结果' },
          { id: 's2-hitl', text: '人工介入：审批弹窗与 agent 主动提问表单' },
          { id: 's2-controls', text: '中断、重试、编辑后重新发送' },
          { id: 's2-virtual', text: '长会话虚拟列表' },
        ],
      },
      {
        title: '对比学习',
        tasks: [
          { id: 's2-compare', text: '对比 Vercel AI SDK、assistant-ui、CopilotKit 各自抽象了什么、放弃了什么' },
        ],
      },
    ],
    deliverable: '一个带工具卡片和审批流程的 Agent Web 应用。',
    resources: [
      { title: 'Vercel AI SDK', url: 'https://ai-sdk.dev/' },
      { title: 'assistant-ui', url: 'https://github.com/assistant-ui/assistant-ui' },
      { title: 'CopilotKit', url: 'https://github.com/CopilotKit/CopilotKit' },
      { title: 'TanStack Virtual', url: 'https://tanstack.com/virtual' },
    ],
    snippetId: 'event-reducer',
  },
  {
    id: 'context-tools',
    index: 3,
    title: '上下文工程与工具设计',
    weeks: '第 9–11 周',
    goal: '决定模型每一轮看到什么，并设计模型能稳定调用的工具。',
    groups: [
      {
        title: '上下文管理',
        tasks: [
          { id: 's3-compaction', text: '对长对话做摘要压缩' },
          { id: 's3-offload', text: '截断或卸载过长的工具结果（写入文件，只返回路径）' },
          { id: 's3-prompt-sections', text: '分段组装 system prompt' },
          { id: 's3-cache', text: '利用 prompt cache 降低成本' },
        ],
      },
      {
        title: '工具设计',
        tasks: [
          { id: 's3-schema-ab', text: '同一能力至少尝试 3 种 schema 写法，比较调用成功率' },
          { id: 's3-schema-notes', text: '总结哪种描述、粒度和错误信息最有效' },
        ],
      },
      {
        title: '知识接入与协议',
        tasks: [
          { id: 's3-rag', text: 'RAG：embedding、混合检索、rerank' },
          { id: 's3-grep', text: '理解为什么 coding agent 中 grep + 读文件常优于向量检索' },
          { id: 's3-mcp', text: '写一个 MCP server 并接入你的 agent' },
          { id: 's3-protocols', text: '了解 ACP 与 LSP 的定位' },
        ],
      },
    ],
    deliverable: '你的 agent 具备上下文压缩、MCP 和 Skill 加载能力。',
    resources: [
      { title: 'Model Context Protocol', url: 'https://modelcontextprotocol.io/' },
      { title: 'Effective context engineering for AI agents', url: 'https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents' },
      { title: 'Writing tools for agents', url: 'https://www.anthropic.com/engineering/writing-tools-for-agents' },
    ],
  },
  {
    id: 'eval-observability',
    index: 4,
    title: '评估与可观测性',
    weeks: '第 12–14 周',
    goal: '让每次提示词或工具改动都有数据支撑。',
    groups: [
      {
        title: 'Eval',
        tasks: [
          { id: 's4-eval-set', text: '建立 20–50 个真实任务的 eval 集，每个都有可自动检查的成功标准' },
          { id: 's4-replay', text: '用 record/replay 录制 LLM 响应，让回归测试不依赖网络与 API key' },
          { id: 's4-judge', text: '对难以自动判定的任务使用 LLM-as-judge，并了解其偏差' },
          { id: 's4-one-command', text: '一条命令跑完整个 eval，并输出成功率变化' },
        ],
      },
      {
        title: '可观测性',
        tasks: [
          { id: 's4-tracing', text: '接入 OpenTelemetry 或 Langfuse' },
          { id: 's4-metrics', text: '记录每一步的 token、延迟、成本和失败原因' },
        ],
      },
    ],
    deliverable: '一条命令跑完 eval；每次改提示词或工具都能看到成功率变化。',
    resources: [
      { title: 'Langfuse', url: 'https://langfuse.com/' },
      { title: 'OpenTelemetry JS', url: 'https://opentelemetry.io/docs/languages/js/' },
      { title: 'SWE-bench', url: 'https://www.swebench.com/' },
    ],
  },
  {
    id: 'advanced',
    index: 5,
    title: '进阶架构',
    weeks: '第 15–18 周',
    goal: '掌握多 Agent、安全、长任务，并能评审工业级框架的取舍。',
    groups: [
      {
        title: '多 Agent',
        tasks: [
          { id: 's5-subagent', text: '实现 subagent 委派：上下文隔离与结果汇总' },
          { id: 's5-orchestrator', text: '实现 orchestrator-worker 模式或共享任务板' },
          { id: 's5-when-not', text: '总结多 Agent 在什么情况下反而让效果变差' },
        ],
      },
      {
        title: '安全',
        tasks: [
          { id: 's5-injection', text: '写出 prompt injection 的威胁模型' },
          { id: 's5-sandbox', text: '了解沙箱：容器、Linux Landlock、Windows ACL' },
          { id: 's5-permissions', text: '设计权限分级与审批策略' },
        ],
      },
      {
        title: '长任务与框架',
        tasks: [
          { id: 's5-long-running', text: '后台任务、断点续跑、目标驱动续跑、计划模式' },
          { id: 's5-frameworks', text: '用 LangGraph.js、OpenAI Agents SDK、Mastra 分别重写你的 agent' },
          { id: 's5-read-oss', text: '对照阅读 Codex CLI、Cline、OpenHands 等工业级实现' },
          { id: 's5-dsh', text: '（可选）带着问题深读 DeepSeek Harness', detail: '顺序：Cordis 教程 → 架构文档 → agent-loop → 工具执行流水线 → compaction → subagent。' },
        ],
      },
    ],
    deliverable: '一份框架对比报告，说明什么时候该用框架、什么时候该手写。',
    resources: [
      { title: 'LangGraph.js', url: 'https://langchain-ai.github.io/langgraphjs/' },
      { title: 'OpenAI Agents SDK (JS)', url: 'https://openai.github.io/openai-agents-js/' },
      { title: 'Mastra', url: 'https://mastra.ai/' },
      { title: 'OpenAI Codex CLI', url: 'https://github.com/openai/codex' },
      { title: 'Cline', url: 'https://github.com/cline/cline' },
      { title: 'OpenHands', url: 'https://github.com/All-Hands-AI/OpenHands' },
      { title: 'DeepSeek Harness', url: 'https://github.com/deepseek-ai/deepseek-harness' },
    ],
  },
  {
    id: 'direction',
    index: 6,
    title: '形成自己的方向',
    weeks: '第 19 周起',
    goal: '把前端能力与 Agent 能力结合，做出代表作品。',
    groups: [
      {
        title: '贡献与作品',
        tasks: [
          { id: 's6-contribute', text: '给开源 Agent 写插件或提交 PR（如新工具 + 前端渲染组件）' },
          { id: 's6-vertical', text: '选一个垂直方向做成作品：前端代码生成、UI 自动化测试、设计稿转代码等' },
        ],
      },
      {
        title: '持续跟进',
        tasks: [
          { id: 's6-follow', text: '跟进模型厂商 changelog、Claude Code / Codex 更新与 SWE-bench 等基准' },
        ],
      },
    ],
    deliverable: '一个公开的 Agent 作品或被合并的开源贡献。',
    resources: [
      { title: 'Browser Use', url: 'https://github.com/browser-use/browser-use' },
      { title: 'Playwright MCP', url: 'https://github.com/microsoft/playwright-mcp' },
    ],
  },
];

export const masteryCriteria: Task[] = [
  { id: 'm-loop', text: '不依赖框架，能讲清并实现一个可取消、可恢复、可回放的 agent 循环' },
  { id: 'm-eval', text: '能用 eval 数据证明某次提示词或工具改动有效' },
  { id: 'm-tools', text: '能设计出模型可以稳定调用的工具，并说明设计理由' },
  { id: 'm-security', text: '能根据场景设计权限、沙箱和审批方案，并说明风险' },
  { id: 'm-review', text: '能评审一个工业级 Agent 框架的设计，指出它的取舍' },
];

export function stageTaskIds(stage: Stage): string[] {
  return stage.groups.flatMap((g) => g.tasks.map((t) => t.id));
}

export const allTaskIds: string[] = [
  ...stages.flatMap(stageTaskIds),
  ...masteryCriteria.map((t) => t.id),
];
