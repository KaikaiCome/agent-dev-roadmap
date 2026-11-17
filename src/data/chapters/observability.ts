import type { Chapter } from '../tutorial';

export const chapter: Chapter = {
  id: 'observability',
  part: 'advanced',
  title: '第 22 章 可观测性：OpenTelemetry 追踪、GenAI 语义约定与 SLO',
  summary: '给参考项目加上分布式追踪，不引入任何依赖：一个最小的 tracer（span、父子关系、W3C traceparent 传播）和一个不会拖慢 Agent 的 OTLP/HTTP 导出器。按 OpenTelemetry GenAI 语义约定记录 run、模型调用、工具调用、审批等待和子 Agent，默认不记录提示词和回答。然后用 Jaeger 看 trace、用 trace 排查一个说不清原因的故障，讨论采样、基数和 PII。最后从事件日志算出成功率、延迟分位数、每次 run 的成本和错误预算燃烧率。',
  minutes: 210,
  outcome: '设置 OTEL_EXPORTER_OTLP_ENDPOINT 后，每次 run 在 Jaeger 里是一棵 invoke_agent → chat / execute_tool → 子 Agent 的 span 树，入站请求的 traceparent 会接上，发给模型的请求也会带上；收集端报错、挂起或宕机时 run 不受影响。不设置时行为和以前完全一样。npm run slo 从事件日志输出 SLO 报表。新增 7 个测试。',
  concepts: [
    { term: '日志、指标、追踪', text: '日志记录“发生了什么”，本项目的事件日志是每个 run 的完整审计记录；指标是聚合后的数字（成功率、p95），适合告警；追踪（trace）记录一个请求经过的每一段调用及耗时，以及它们的父子关系，适合回答“这次为什么慢、卡在哪一步、是哪个服务出的错”。三者互补，不是互相替代。' },
    { term: 'span 与 trace', text: 'span 是一段有开始和结束的操作，带名称、属性、事件和状态（ok / error）。一个 trace 是同一 traceId 下的所有 span，按 parentSpanId 连成一棵树。span 的上下文（traceId + spanId + 采样标志）随调用传递，跨进程时放在 HTTP 头 traceparent 里。' },
    { term: 'OTLP', text: 'OpenTelemetry 的传输协议。本章用 OTLP/HTTP 的 JSON 编码，POST 到 <收集端>/v1/traces。Jaeger、Grafana Tempo、各家云厂商的 APM 都直接接收 OTLP，换后端只需要改地址。' },
    { term: 'GenAI 语义约定', text: 'OpenTelemetry 为大模型应用定义的统一属性名：gen_ai.operation.name、gen_ai.request.model、gen_ai.usage.input_tokens 等。统一命名后，同一个看板能看不同框架、不同语言写的 Agent。截至本章写作时，所有 gen_ai.* 属性仍是 Development（开发中）状态，可能改名，规范已移到单独的 semantic-conventions-genai 仓库。' },
    { term: 'SLO 与错误预算', text: 'SLO（服务等级目标）是对用户承诺的可度量目标，例如“7 天内 95% 的 run 成功完成”。错误预算是允许失败的余量（这里是 5%）；燃烧率 = 实际失败率 ÷ 允许失败率，大于 1 表示照这个速度，周期没结束预算就会用完。' },
  ],
  steps: [
    {
      title: '事件日志已经有了，为什么还要追踪',
      text: [
        '第 4 章的事件日志记录了每个 run 的每一步：模型输出、工具参数和结果、审批、用量。排查单个 run，`npm run replay` 已经够用。它缺的是三样东西：① 跨进程：请求从网关、前端服务进来，Agent 再去调模型服务和工单系统，事件日志只看得到 Agent 自己这一段；② 耗时结构：一次 run 慢了 20 秒，是哪次模型调用慢、首个 token 慢还是输出长、是不是在重试；③ 聚合查询：“过去一小时 deepseek-chat 的 chat span 里 error.type=503 的有多少”，事件日志要写 SQL，追踪后端直接能查。',
        '本章的设计约束：零依赖（不装 @opentelemetry/* 包，代码量小到每一行都能读懂）；默认关闭，只有设置了标准环境变量 `OTEL_EXPORTER_OTLP_ENDPOINT` 才开启，所以前面所有章节的输出一字不变；导出永远不能阻塞或拖垮 Agent。',
        '生产环境建议直接用官方 SDK（@opentelemetry/sdk-node），它多了自动埋点、指标、日志和更完整的导出器。手写一遍的价值在于弄清楚 SDK 背后做了什么，出问题时知道该看哪里。',
      ],
      files: ['src/telemetry/index.ts', 'src/main.ts'],
    },
    {
      title: '最小 tracer：span、上下文和 traceparent',
      text: [
        '`Span` 只有几样东西：traceId（16 字节）、spanId（8 字节）、父 spanId、名称、kind（INTERNAL / SERVER / CLIENT）、属性、事件、状态、起止时间。`fail(errorType, message)` 设置稳定属性 `error.type` 和错误状态；`end()` 把采样到的 span 交给处理器。',
        '“当前 span”放在 `AsyncLocalStorage` 里：`withSpanContext(span, fn)` 里发起的所有异步调用，`startSpan` 不指定父 span 时都会自动挂到它下面。这正是子 Agent 不用改一行代码就能挂进同一棵树的原因：子 Agent 的 runAgent 在父 Agent 的 execute_tool span 上下文里执行。',
        'W3C Trace Context 的格式是 `版本-traceId-父spanId-标志`。`parseTraceparent` 严格校验：长度、只能是小写十六进制、全 0 的 id 无效、版本 ff 无效。校验失败就当作没有这个头，开一条新的 trace，而不是报错——外部传来的头是不可信输入。采样标志 01 表示上游决定记录，00 表示不记录：本项目尊重上游的决定（parent-based 采样），只有没有上游时才按 `OTEL_TRACES_SAMPLER_ARG` 的比例，用 traceId 的后 8 位做确定性的头部采样。',
      ],
      files: ['src/telemetry/trace.ts'],
      code: {
        title: 'traceparent 头（W3C Trace Context）',
        content: `traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
              │  │                                │                │
              │  traceId（整条链路共用）          父 spanId        采样标志：01 记录，00 不记录
              版本`,
      },
    },
    {
      title: '导出器：有界队列、批量、超时、失败就丢',
      text: [
        '`BatchSpanProcessor` 把结束的 span 放进内存队列，攒够一批（默认 256 个）或等 1 秒后，POST 到收集端。同一时间最多一个请求在途，定时器 `unref()`，不会让进程因为它而不退出。',
        '四条保护，都是为了“追踪坏了，Agent 照常工作”：① 队列有上限（默认 2048），满了新 span 直接丢弃并计数，收集端慢不会让内存无限增长；② 每个请求有超时（默认 5 秒，`AbortSignal.timeout`）；③ 失败的批次直接丢弃，不重试；④ 错误只通过回调报告，`main.ts` 里每 60 秒最多打一条日志，收集端挂了不会刷屏。`stats` 记录已导出、已丢弃和失败的请求数，可以接到指标里监控。',
        '第 ③ 条是有意的取舍：OTLP 规范建议对可重试的错误做退避重试，官方 SDK 也会这样做。本项目选择简单和可预测，代价是收集端短暂抖动时会丢一些 trace。trace 本来就会被采样，丢一部分可以接受；需要“一条不能少”的数据（审计、SLO）不应该依赖追踪，下面第 10 步的 SLO 就是从事件日志算的。',
        '服务退出时 `shutdown()` 会把队列里剩下的 span 发出去（同样受超时限制），所以优雅退出不会丢掉最后几秒的 trace。',
      ],
      files: ['src/telemetry/otlp.ts'],
    },
    {
      title: 'GenAI 语义约定：用对属性名',
      text: [
        '属性名照抄规范，不要自己起。下面这些名称按 OpenTelemetry semantic-conventions-genai 仓库的当前版本核对过。所有 `gen_ai.*` 都是 Development 状态，`error.type`、`server.address`、`server.port` 是 Stable。Development 意味着升级时可能改名（历史上 `gen_ai.system` 就改成了 `gen_ai.provider.name`），所以属性名集中在 `genai.ts` 一个文件里，升级只改这一处。',
        '名称有固定格式：模型调用叫 `chat {模型}`，kind 是 CLIENT；工具调用叫 `execute_tool {工具名}`，kind 是 INTERNAL；进程内的 Agent 叫 `invoke_agent {Agent 名}`，kind 是 INTERNAL（调用远程 Agent 服务时才是 CLIENT）。',
        '规范没有覆盖的，用自己的命名空间：`app.run.id`、`app.tenant.id`、`app.run.status`、`app.usage.estimated`（mock 或服务商没返回用量时 token 是估算的）。不要往 `gen_ai.*` 里塞自定义属性，将来可能和规范冲突。',
        '`gen_ai.provider.name` 按 LLM_BASE_URL 推断：deepseek、azure.ai.openai、moonshot_ai 是规范里的已知值，其余兼容 OpenAI 的服务记为 openai，离线模型记为 mock。',
      ],
      files: ['src/telemetry/genai.ts'],
      code: {
        title: '本项目记录的属性',
        content: `invoke_agent ticket-agent   (INTERNAL，每段 run 一个，是整棵树的根)
  gen_ai.operation.name=invoke_agent  gen_ai.provider.name  gen_ai.agent.name  gen_ai.request.model
  gen_ai.usage.input_tokens / output_tokens（这一段 run 自己的模型调用，不含子 Agent）
  app.run.id  app.run.parent_id  app.tenant.id  app.run.resumed  app.run.status
chat {model}                (CLIENT)
  gen_ai.operation.name=chat  gen_ai.provider.name  gen_ai.request.model  gen_ai.request.max_tokens
  gen_ai.request.stream  gen_ai.response.model  gen_ai.response.finish_reasons（字符串数组）
  gen_ai.usage.input_tokens  gen_ai.usage.output_tokens  gen_ai.response.time_to_first_chunk（秒）
  server.address  server.port  error.type（失败时：HTTP 状态码、timeout、cancelled …）
execute_tool {tool}         (INTERNAL)
  gen_ai.operation.name=execute_tool  gen_ai.tool.name  gen_ai.tool.call.id  gen_ai.tool.type=function
  error.type（失败时：工具返回的错误码）
approval_wait {tool}        (INTERNAL，规范里没有，本项目自定义)
只有开启内容记录才有：gen_ai.system_instructions  gen_ai.input.messages  gen_ai.output.messages
                      gen_ai.tool.call.arguments  gen_ai.tool.call.result`,
      },
    },
    {
      title: '埋点：run、模型调用、工具调用、审批等待、子 Agent',
      text: [
        '`runAgent` 现在是一层包装：有遥测时在 `invoke_agent` span 里执行原来的循环（`runLoop`），没有时直接执行。循环里只改了两处：模型调用经过 `telemetry.chat(...)`，工具调用经过 `telemetry.tool(...)`。重试和降级发生在模型适配器内部，所以一个 chat span 覆盖“一次逻辑调用”，包括重试。',
        'execute_tool span 的成功与否、错误码不是从异常里猜的，而是从事件日志的 `tool_finished` 读出来的，保证 trace 和审计日志说的是同一件事。需要审批的工具第一次执行时只是发起审批、run 暂停，这时不产生 execute_tool span；员工批准后 run 恢复，是新的一段 run（新的 invoke_agent span），这段里先补一个 `approval_wait` span（起止时间取自事件日志），再是真正的 execute_tool。',
        '两段 run 可能不在同一条 trace 里：恢复请求带了 traceparent 就挂在它下面，否则开新的 trace，服务重启后恢复的 run 也是新 trace。它们靠 `app.run.id` 关联，在 Jaeger 里按这个 tag 搜索就能找到同一个 run 的所有段。approval_wait 的开始时间早于它所在的 run 段，Jaeger 会画在父 span 左边，这是正常的。',
        '子 Agent 不需要改代码：`subagent.ts` 调用 `runAgent` 时没有传遥测，`runAgent` 会从 AsyncLocalStorage 里取当前的遥测实例，子 run 的 invoke_agent span 自然挂在父 run 的 `execute_tool research` 下面。',
        '跨进程：`server.ts` 把 POST /api/runs 和审批接口收到的 traceparent 头交给 `continueFrom`；OpenAI 兼容适配器发请求时加上 `traceHeaders()`，值是当前 chat span 的上下文。下面是用一个小脚本接收 OTLP 后打印出来的真实 span 树（开启子 Agent，问差旅住宿标准）。',
      ],
      files: ['src/agent.ts', 'src/subagent.ts', 'src/server.ts', 'src/llm/openai.ts'],
      output: `traceId 3d683791ad682d6f136c92b59124fd7e，共 8 个 span
invoke_agent ticket-agent  5ms  request.model="mock" usage.input_tokens=631 usage.output_tokens=67 agent.name="ticket-agent" app.run.status="completed"
  chat mock  0ms  request.model="mock" usage.input_tokens=238 usage.output_tokens=10 response.finish_reasons=["tool_calls"]
  execute_tool research  2ms  tool.name="research"
    invoke_agent research  2ms  request.model="mock" usage.input_tokens=414 usage.output_tokens=67 agent.name="research" app.run.status="completed"
      chat mock  0ms  request.model="mock" usage.input_tokens=151 usage.output_tokens=10 response.finish_reasons=["tool_calls"]
      execute_tool search_knowledge  0ms  tool.name="search_knowledge"
      chat mock  0ms  request.model="mock" usage.input_tokens=263 usage.output_tokens=57 response.finish_reasons=["stop"]
  chat mock  0ms  request.model="mock" usage.input_tokens=393 usage.output_tokens=57 response.finish_reasons=["stop"]`,
      outputNote: '打印脚本省略了 gen_ai. 前缀，只列了部分属性，数组和整数的 OTLP 编码也简化了。traceId 每次不同；mock 模型几乎不耗时，所以都是个位数毫秒。根 span 的 631 = 238 + 393，是主 Agent 自己的两次模型调用，子 Agent 的 414 记在它自己的 span 上，算整棵树的成本时要把它们加起来。',
    },
    {
      title: '隐私：默认不记录内容，以及测试',
      text: [
        '提示词、回答、工具参数和结果里有员工的问题、制度原文、工单内容，可能包含个人信息和机密。trace 后端的访问控制和保留期通常比业务数据库宽松得多，所以规范要求内容默认不记录。本项目只认 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT=SPAN_ONLY`（或 SPAN_AND_EVENT，大小写不敏感）时才在 span 上记录，写成 true 之类无法识别的值按不记录处理。',
        '默认情况下也刻意不记录员工 id（`user.id` 是个人信息），只记录租户 id；失败原因（span 状态的 message）可能包含工具返回的错误信息，开启前确认它们不带个人信息。',
        '测试用一个进程内的 HTTP 收集端接收导出的 JSON，可以让它正常返回、返回 500、挂起不响应，或者干脆用一个没有监听的端口。覆盖：span 树形状和属性名；默认导出的 JSON 里搜不到问题和回答的原文；开启后才有内容；子 Agent 挂在父 trace 里；审批的两段 run；入站和出站的 traceparent（包括无效头开新 trace、标志 00 不导出但继续向下传）；收集端出错时 run 照常完成、队列有上限；以及第 10 步的 SLO 计算。',
      ],
      files: ['test/observability.test.ts'],
      command: 'node --test test/observability.test.ts',
      output: `✔ 一次 run 产生 invoke_agent → chat / execute_tool 的 span 树，属性名符合 GenAI 语义约定，默认不导出内容 (38.2927ms)
✔ 只有显式开启 OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT 才在 span 上记录提示词、回答和工具参数 (9.1759ms)
✔ 子 Agent 的 run 作为子 span 挂在父 run 的 execute_tool research 下面，同一条 trace (9.5282ms)
✔ 审批暂停的工具调用不产生 execute_tool span；恢复后补记 approval_wait，两段 run 都有记录 (63.1826ms)
✔ traceparent：入站请求的上下文成为 run 的父 span，出站模型请求带上 chat span 的上下文 (21.8237ms)
✔ 收集端报错、挂起或不可达都不影响 run；队列有上限，超出的 span 被丢弃并计数 (219.3107ms)
✔ SLO 从事件日志计算：子 Agent 成本算到根 run，审批等待不计入延迟，取消不计入，卡住算失败 (1.204ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0`,
      outputNote: '省略了 suites、skipped 等为 0 的统计行。耗时每次不同；“收集端出错”那条最慢，因为它要等挂起的请求超时。',
    },
    {
      title: '用 Jaeger 看 trace',
      text: [
        'Jaeger v2 的镜像直接接收 OTLP（4317 是 gRPC，4318 是 HTTP），16686 是界面。启动后让服务把 trace 发到 4318，然后在界面上提几个问题、提交一张工单。',
        '在 Jaeger 界面选择服务 ticket-agent，可以按 tag 过滤，例如 `error=true`、`gen_ai.request.model=deepseek-chat`、`app.run.id=run_xxx`（找同一个 run 的所有段）。用真实模型时，点开一个 chat span，看 `gen_ai.response.time_to_first_chunk` 和整个 span 的耗时之差，就知道慢在排队还是慢在输出。',
        '旧的 `jaegertracing/all-in-one` 镜像是 Jaeger v1，需要加 `-e COLLECTOR_OTLP_ENABLED=true`（较新的 v1 版本已默认开启），v1 已停止维护，新项目用 v2。Jaeger 适合本地和小规模使用；生产上常见的是 OpenTelemetry Collector 加 Tempo、云厂商 APM 或 Jaeger 配持久化存储。',
      ],
      command: `docker run --rm --name jaeger -p 16686:16686 -p 4317:4317 -p 4318:4318 jaegertracing/jaeger:latest

# 另一个终端。macOS / Linux
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run server
# Windows PowerShell
$env:OTEL_EXPORTER_OTLP_ENDPOINT='http://localhost:4318'; npm run server`,
      output: `{"time":"…","level":"info","message":"tracing enabled","sampleRatio":1,"captureContent":false}
{"time":"…","level":"info","message":"server started","port":8787,"model":"mock","recoveredRuns":0}`,
      outputNote: 'docker 那一行在编写本章的机器上没有运行（没有安装 Docker），它的输出是 Jaeger 自己的启动日志，看到 OTLP receiver 监听 4318 即可；然后用浏览器打开 http://localhost:16686。服务的两行日志是真实输出（时间已省略）：只有设置了收集端地址才会出现 tracing enabled，不设置时只有第二行。没有启动 Jaeger 时服务照常工作，只是每 60 秒打一条“OTLP 导出失败，丢弃 N 个 span”的错误日志。',
    },
    {
      title: '用 trace 排查一个说不清原因的故障',
      text: [
        '典型的报告是“今天下午 Agent 经常答一半就没了”或者“有时候特别慢”。没有明确报错，没法直接定位。用 trace 的步骤：',
        '① 先圈范围：在追踪后端按时间段、`error=true` 和 `app.run.status` 过滤，看失败的 run 是集中在某个租户、某个模型、还是某个时间点。只有某个租户出问题，多半是数据或权限；所有租户在同一时间段出问题，多半是依赖。',
        '② 再看形状：打开几条失败和几条正常的 trace 对比。失败的 trace 是在 chat span 上结束（看 `error.type`：429 是限流，503 是服务商故障，timeout 是超时）、在某个 execute_tool 上出错（看错误码），还是 chat span 正常但 run 以 budget_exceeded 结束（模型在循环里反复调用同一个工具——数一数 execute_tool 的个数）。',
        '③ 用聚合验证假设：比如怀疑是长上下文导致超时，就对比失败和成功的 chat span 的 `gen_ai.usage.input_tokens` 分布，而不是只看一两条。',
        '④ 找到可疑的 run 后，用 `app.run.id` 回到事件日志，`npm run replay -- <runId>` 看模型实际看到了什么、说了什么。trace 告诉你哪一步出了问题，事件日志告诉你为什么——内容不在 trace 里，这正是默认不记录内容的设计。',
        '⑤ 跨服务的问题要靠 traceparent：网关、Agent、模型代理都接入同一个追踪后端，才能看到“慢在网关排队”还是“慢在模型”。把 traceparent 发给第三方模型服务有一点代价：对方能看到你的 trace id（不含内容），如果在意，可以只对内部服务传播。',
      ],
      files: ['examples/04-replay-run.ts'],
    },
    {
      title: '采样、基数与成本',
      text: [
        '头部采样（head sampling）：在 trace 开始时决定记不记，后面所有 span 跟着同一个决定（traceparent 的标志位）。实现简单、开销低，本项目用的就是这种，`OTEL_TRACES_SAMPLER_ARG=0.1` 就只记 10%。缺点是决定时还不知道这次会不会出错，罕见的失败可能正好没被采到。',
        '尾部采样（tail sampling）：先把整条 trace 的 span 都收集起来，结束后再按规则决定，例如“出错的全留、慢于 10 秒的全留、其余留 5%”。它需要一个能缓存完整 trace 的组件（通常是 OpenTelemetry Collector 的 tail_sampling 处理器），而且同一条 trace 的 span 要路由到同一个实例。Agent 的 trace 往往持续几十秒甚至跨越审批，缓存窗口要按这个设。',
        '基数（cardinality）：span 名称和用来做指标、分组的维度必须是有限的几种值。本项目的 span 名称只包含操作和模型名、工具名，run id、租户 id、员工问题都在属性里，绝不拼进名称。把问题文本或 run id 放进 span 名称，或者从 span 生成指标时按 run id 分组，会让后端的索引和指标数量爆炸。',
        'PII 和保留期：即使不记录内容，属性里的 id、错误信息也可能指向个人。给 trace 设比业务日志更短的保留期；按租户隔离或脱敏；开启内容记录前先确认有法律依据和访问控制，最好只在排查期间对单个租户短时间开启。',
        '成本：span 数量 ≈ run 数 × 每个 run 的步骤数。一个 Agent run 动辄十几个 span，比普通 Web 请求多一个数量级，采样比例要按后端的计费方式算一下。',
      ],
    },
    {
      title: 'SLO：从事件日志算，而不是从 trace 算',
      text: [
        'SLO 要回答“所有请求里有多少成功”，数据源必须不采样、不丢。trace 两条都不满足，事件日志两条都满足，所以 `slo.ts` 直接读 runs、events、run_links 三张表。',
        '口径要先说清楚：① 只算顶层 run，子 Agent 是实现细节，它的成本算到根 run 上；② 成功 = completed；failed 和 budget_exceeded 算失败；还在 running 但超过 10 分钟的算失败（卡住），否则最严重的故障——进程挂死——反而不出现在报表里；用户取消、等待审批、刚开始的不计入；③ 延迟 = 结束时间 − 开始时间 − 审批等待，员工过了十分钟才点批准不是 Agent 慢；④ 分位数用最近秩法，p95 一定是真实出现过的某个值；⑤ 价格是示例值。',
        '燃烧率要看多个窗口：7 天的燃烧率 0.8，看起来还在预算内；最近 1 小时是 13.3，说明正在发生故障。常见做法是“1 小时燃烧率 > 14 且 5 分钟燃烧率 > 14 才报警”这样的多窗口规则，既快又不容易误报。',
        '下面是对一组固定种子生成的模拟数据（7 天、400 个 run、最近几小时模型服务出故障）的真实输出。`npm run slo -- data/agent.db` 可以对你本地真实运行留下的数据库计算最近 7 天。',
      ],
      files: ['src/telemetry/slo.ts', 'examples/08-slo.ts'],
      command: 'npm run slo',
      output: `数据：data/slo-demo.db（模拟数据）  窗口：2025-06-01T00:00 → 2025-06-08T00:00
顶层 run 403 个，计入 SLO 391 个，不计入：cancelled 10，waiting_approval 1，running 1

成功率      96.2%  （目标 95.0%，成功 376 / 失败 15）
延迟 p50    9.7 s
延迟 p95    32.9 s  （目标 ≤ 20.0 s，超标的 run 9.6%；不扣审批等待的 p95 是 479.1 s）
每次 run    ¥0.0200  （p95 ¥0.0368，合计 ¥7.8265，含子 Agent）
错误预算    允许失败 19.6 次，已用 76.7%

燃烧率（窗口失败率 ÷ 允许失败率；1 = 刚好在周期末用完）
  最近 1 小时  run   3  失败  2  燃烧率 13.3
  最近 6 小时  run  15  失败  5  燃烧率 6.7
  最近 1 天   run  57  失败  5  燃烧率 1.8
  最近 7 天   run 391  失败 15  燃烧率 0.8

失败原因
    7  budget_exceeded：超过最多 8 步
    4  failed：模型调用失败：503 Service Unavailable
    3  failed：工具 search_knowledge 连续失败
    1  卡住：超过 10 分钟未结束`,
      outputNote: '数据是脚本用固定种子生成的模拟数据，每次运行结果相同，只用来说明计算方法，不代表真实模型的表现。“不扣审批等待的 p95 是 479.1 s”说明了第 ③ 条口径的重要性：不扣除的话，延迟 SLO 衡量的其实是员工多久点批准。',
    },
  ],
  pitfalls: [
    { symptom: '收集端一挂，Agent 的响应也变慢甚至超时', cause: '导出在请求路径上同步执行，或者没有超时、失败后无限重试，队列无上限导致内存上涨。', fix: '导出放在后台批量进行，有超时、有界队列，失败就丢弃并计数；测试里用一个挂起不响应的收集端验证 run 的耗时不受影响。' },
    { symptom: 'Jaeger 里每个 run 都是孤零零的一个 span，模型调用和工具调用不在它下面', cause: '异步调用之间没有传递上下文，子 span 拿不到父 span，各自开了新的 trace。', fix: '用 AsyncLocalStorage 保存当前 span，在 withSpanContext 里执行子操作；跨进程用 traceparent 头。测试里断言所有 span 的 traceId 相同、parentSpanId 指向正确。' },
    { symptom: '追踪后端的账单或索引量突然暴涨', cause: '把 run id、员工问题之类的高基数值拼进了 span 名称或指标维度。', fix: 'span 名称只用有限的值（操作 + 模型名 / 工具名），高基数的值放在属性里；按属性生成指标前先确认取值是有限的。' },
    { symptom: '安全审查发现 trace 后端里有员工的报销金额、工单描述', cause: '默认记录了提示词、回答和工具参数，或者把带个人信息的错误信息写进了 span 状态。', fix: '内容默认不记录，只有 OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT=SPAN_ONLY 才开启；写测试搜索导出的 JSON，确保默认情况下找不到问题和回答的原文。' },
    { symptom: '升级依赖或换了追踪后端后，看板上 token 用量全部变成空', cause: 'GenAI 语义约定仍是 Development 状态，属性名改过（例如 gen_ai.system → gen_ai.provider.name，prompt_tokens → input_tokens）。', fix: '属性名集中在一个文件里；升级时对照规范的变更记录；看板查询同时兼容新旧名称一段时间。' },
    { symptom: 'SLO 报表显示成功率很高，但用户一直在抱怨', cause: '从采样后的 trace 计算，或者只统计了“已结束的 run”，卡住不结束的 run 根本不在分母里；延迟里还混进了审批等待。', fix: '从不采样的事件日志计算；超过时限仍在运行的算失败；延迟扣除审批等待；口径写进文档。' },
  ],
  exercises: [
    { id: 't-obs-jaeger', text: '用 Docker 启动 Jaeger，配置 OTEL_EXPORTER_OTLP_ENDPOINT 启动服务，提交一张需要审批的工单。在 Jaeger 里用 app.run.id 找到两段 run，截图说明 approval_wait 为什么画在父 span 左边' },
    { id: 't-obs-tail-sampling', text: '在导出器前实现一个简单的尾部采样处理器：按 traceId 缓存 span，根 span 结束后，出错或耗时超过阈值的 trace 全部保留，其余按 10% 保留', detail: '写测试覆盖：出错的 trace 一定被导出；子 Agent 的 span 和父 run 的 span 一起决定；缓存有上限，超过时按最旧的 trace 丢弃。' },
    { id: 't-obs-metrics', text: '用同样的 OTLP/HTTP JSON 格式导出两个指标：gen_ai.client.token.usage（直方图，按 gen_ai.token.type 区分输入和输出）和 gen_ai.client.operation.duration，并对照语义约定确认指标名、单位和维度' },
    { id: 't-obs-burn-alert', text: '在 slo.ts 上实现多窗口燃烧率告警：1 小时和 5 分钟的燃烧率都超过 14 时输出“页面告警”，6 小时和 30 分钟都超过 6 时输出“工单告警”，用模拟数据验证故障开始后多久触发、恢复后多久解除' },
    { id: 't-obs-debug', text: '用 mock 模型构造一个“偶发失败”：让 search_knowledge 每 5 次失败 1 次。只看 trace（不看代码和事件日志），写一份排查记录，说明你如何定位到这个工具，再用事件日志确认原因' },
  ],
  deeper: { stageId: 'eval-observability', text: '深入专题：评测与可观测性' },
  interview: [
    { q: '你会怎样给一个 Agent 加可观测性？记录哪些东西？', a: [
      '三类数据：事件日志（每个 run 的完整审计记录，不采样）、追踪（每次请求的 span 树和耗时）、指标（成功率、延迟、token、成本，用于告警）。',
      '追踪的结构：run 是根 span，下面是每次模型调用（chat）、工具调用（execute_tool）、审批等待和子 Agent（invoke_agent）。属性按 OpenTelemetry GenAI 语义约定命名：模型、provider、token 用量、结束原因、首 token 时间、error.type。',
      '默认不记录提示词和回答，需要时用规范定义的开关短时间开启；导出不能阻塞 Agent；traceparent 跨进程传播，让网关、Agent、模型代理在同一条 trace 里。',
    ] },
    { q: '头部采样和尾部采样有什么区别？Agent 场景该怎么选？', a: [
      '头部采样在 trace 开始时决定，简单、便宜，但不知道这次会不会出错；尾部采样在 trace 结束后按结果决定，能保证出错和慢的都留下，但需要缓存完整 trace 的组件，并且同一条 trace 要路由到同一个实例。',
      'Agent 的 trace 长（几十秒，跨越审批时更长）、span 多、失败相对少见但很重要，适合“头部按一个较高比例采样 + 收集端尾部采样保留错误和慢请求”。SLO 不从 trace 算，所以采样不影响 SLO 的准确性。',
    ] },
    { q: 'Agent 的 SLO 怎么定义？和普通 Web 服务有什么不同？', a: [
      '成功率要定义清楚“成功”：completed 才算，超出预算、模型失败、卡住不结束都算失败，用户取消和等待人工审批不计入。延迟要扣掉人工等待时间，否则衡量的是人而不是系统。',
      '成本是 Agent 特有的一维：每次 run 的 token 和费用，要算整棵调用树（含子 Agent），看 p95 而不只是平均值。',
      '用错误预算和多窗口燃烧率告警，而不是固定阈值：长窗口判断趋势，短窗口确认故障正在发生，两者同时超过才告警。',
    ] },
    { q: 'trace 里能不能放提示词和模型输出？', a: [
      '默认不能。内容可能包含个人信息和机密，而 trace 后端的权限和保留期通常比业务库宽松。GenAI 语义约定也把 gen_ai.input.messages 等定义为 opt-in。',
      '需要排查时，用 OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT 之类的开关，对特定租户、短时间开启，并配合更短的保留期和访问审计；平时通过 run id 回到有权限控制的事件日志查看内容。',
    ] },
  ],
};
