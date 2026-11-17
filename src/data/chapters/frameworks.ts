import type { Chapter } from '../tutorial';

export const chapter: Chapter = {
  id: 'frameworks',
  part: 'advanced',
  title: '第 26 章 框架对比：OpenAI Agents SDK 与 LangGraph.js',
  summary: '用 @openai/agents 和 @langchain/langgraph 各重写一遍参考项目的核心流程（检索工具、需审批的建单工具、多轮对话），并和手写实现对比。三者共用同一套工具、权限规则、种子文档和离线模型，每一处差异都由测试固定下来。',
  minutes: 90,
  outcome: '一个独立子项目 course/ticket-agent/frameworks：两个框架版本的工单助手、一份三方逐字对比的演示，以及 11 个离线测试。测试覆盖权限过滤、拒答、审批中断与恢复、拒绝、重复恢复、检查点重放、多轮记忆和流式输出。读完你能说清什么时候该用框架、该用哪个，以及怎样从手写版迁移过去。',
  concepts: [
    { term: '编排框架', text: '替你写“调模型 → 执行工具 → 把结果交回模型”这个循环的库，通常还附带审批中断、状态持久化、追踪和流式输出。工具的业务逻辑、权限和幂等仍然要你自己写。' },
    { term: 'Runner / RunState（Agents SDK）', text: 'Runner 执行 Agent 的循环。遇到 needsApproval 的工具调用就停下，把待审批项放进 result.interruptions。RunState 是这次 run 的完整快照，可以 toString() 存起来，之后再 fromString 恢复。' },
    { term: 'StateGraph / checkpointer（LangGraph）', text: '把流程画成显式的状态机：节点读写共享状态，边决定下一步。每走完一步，checkpointer 按 thread_id 保存一个检查点。interrupt() 让图停在节点内部，之后用 Command({ resume }) 从检查点继续。' },
    { term: '同口径对比（apples-to-apples）', text: '两个框架版本都直接调用 ../src 的工具实现、权限过滤、系统提示词和 mock 模型，框架只负责编排。这样回答不同、token 不同或工单数不同时，原因只能出在编排层。' },
    { term: '重放（replay）', text: '框架为了恢复或“时间旅行”，会从某个检查点重新执行后续步骤。重放到写操作时，副作用会再发生一次，除非工具本身是幂等的。' },
  ],
  steps: [
    {
      title: '1. 为什么要对比，以及怎样做到同口径',
      text: [
        '面试和技术选型时常被问到：“为什么不用 LangGraph 或 Agents SDK？”只读文档回答不了，因为框架的宣传页都只展示好的一面。最可靠的做法是拿自己的真实流程分别写一遍，跑同一组用例，比较回答、调用次数、工单数和代码量。',
        '子项目放在 course/ticket-agent/frameworks，有自己的 package.json，依赖全部锁定精确版本：@openai/agents 0.22.0、@langchain/langgraph 1.7.5、@langchain/core 1.4.1、zod 4.6.7。安装后共 51 个包、约 114 MB（mcp 子项目约 23 MB）。参考项目本身仍然零依赖。',
        'shared.ts 是两个框架共用的薄适配层。工具通过 createTools(store) 取得，参数解析、权限过滤、草稿归属校验和幂等键全部沿用参考项目。工具结果用同样的 { ok, data } / { ok: false, error } 信封交给模型。审批文案用参考工具的 describe 生成。框架只负责编排，业务规则只有一份。',
        '两个框架都接入参考项目的离线 mock 模型（第 2 章），所以测试不需要 API key 也不访问网络。这样做的代价是：本章证明的是“编排行为一致”，不能证明“真实模型在两个框架下表现一样”。',
      ],
      files: ['frameworks/package.json', 'frameworks/shared.ts'],
      command: 'cd course/ticket-agent/frameworks\nnpm ci\nnpm test',
      output: `✔ 同一组对话，手写版、Agents SDK、LangGraph 给出逐字相同的回答和同样多的工单 (232.5255ms)
✔ 工具契约：两个框架发给模型的工具名、字段说明和系统提示词与手写版一致；Agents SDK 的 strict 模式把可选字段变成必填 (11.6838ms)
✔ Agents SDK：检索沿用参考项目的权限过滤，工具调用出现在追踪里 (5.3061ms)
✔ Agents SDK：没有可见依据时拒答，不编造 (3.8122ms)
✔ Agents SDK：needsApproval 暂停 run；序列化后用当前身份恢复，同意只建一张工单，重复恢复也不会多建 (12.4068ms)
✔ Agents SDK：拒绝后模型收到 APPROVAL_REJECTED，不建单 (5.9673ms)
✔ Agents SDK：Session 保存多轮历史；流式输出拼起来等于最终回答 (14.7689ms)
✔ LangGraph：检索沿用权限过滤；工具调用触发回调（追踪）；没有依据时拒答 (20.234ms)
✔ LangGraph：interrupt 暂停在审批节点；换一个图实例（模拟重启）恢复，已执行的工具不会重跑 (23.84ms)
✔ LangGraph：拒绝不建单；从审批前的检查点重放会再次执行写工具，只靠幂等键挡住重复 (48.5686ms)
✔ LangGraph：同一线程保留多轮历史，不同线程互不可见；streamMode messages 逐段输出 (20.4479ms)
ℹ tests 11
ℹ pass 11
ℹ fail 0`,
      outputNote: '耗时每次运行都不同。这是离线 mock 模型的结果，只验证编排行为，不代表真实模型的回答质量。',
    },
    {
      title: '2. 工具定义与 schema：两个框架都用 zod，但细节不同',
      text: [
        'Agents SDK 用 tool({ name, description, parameters, execute })，LangChain 用 tool(fn, { name, description, schema })。两者都把 zod 转成 JSON Schema 发给模型，并在执行前校验参数。工具名、说明和每个字段的 .describe() 都直接取自参考工具的 spec，所以三种实现发给模型的工具契约一致，这一点有测试检查。',
        '第一处差异：Agents SDK 默认使用 strict 模式，要求所有字段都出现在 required 里。手写版的 sourceIds 是可选的，到了 SDK 里会变成必填。如果模型没有可填的值，就只能填空数组。LangGraph 版保留了 .optional()。这类差异不会报错，只会悄悄改变模型看到的契约，所以测试里直接断言 required 列表。',
        '第二处差异：身份怎么传给工具。Agents SDK 把 context 放在 RunContext 里，工具从 runContext.context 读取，不会发给模型。LangGraph 把身份放在 config.configurable 里，每次 invoke 时由服务端注入，不写进图状态。两种做法都满足第 5 章的原则：身份来自服务端，不由模型决定。',
      ],
      files: ['frameworks/openai-agents.ts'],
      code: {
        title: '同一个建单工具的两种写法（节选）',
        content: `// OpenAI Agents SDK
const createTicket = tool({
  name: 'create_ticket',
  description: ref('create_ticket').spec.description,
  parameters: z.object({ draftId: z.string().max(64).describe(field('create_ticket', 'draftId')) }),
  needsApproval: true,   // Runner 不执行，放进 result.interruptions
  execute: (args, runContext, details) =>
    runReferenceTool(ref('create_ticket'), args, callContext(runContext, details?.toolCall?.callId)),
});

// LangGraph / LangChain：是否需要审批不写在工具上，由图里的 approve 节点决定
tool((args, config) => runReferenceTool(ref(name), args, { ...contextOf(config), callId: config.toolCall?.id }),
  { name, description: ref(name).spec.description, schema });`,
      },
    },
    {
      title: '3. 模型适配器：框架真正依赖的接口',
      text: [
        '要让框架离线运行，必须给它接一个假模型。这一步也最能看出框架的抽象边界。Agents SDK 需要实现 Model 接口：getResponse 返回 Responses API 风格的 output 条目（message / function_call），getStreamedResponse 产出 output_text_delta 和 response_done 事件。再通过 ModelProvider 交给 Runner。',
        'LangGraph 本身不关心模型，模型由 LangChain 的 BaseChatModel 提供。需要实现 _generate、_streamResponseChunks 和 bindTools（用 convertToOpenAITool 把工具转成 OpenAI 格式）。',
        '两个适配器各约 60 行，做的事情相同：把框架的消息格式转回参考项目的 Message[]，再把 ModelResponse 转成框架的格式。生产环境里这一层会换成 OpenAI provider 或 ChatOpenAI。但写一遍很有价值：你会清楚框架在每次调用时到底给模型发了什么。',
        '对比后的结论：两个框架在这个配置下都没有偷偷加系统提示词。发给模型的 system 消息就是 systemPrompt(user)，测试里逐字检查过。但工具结果的格式、拒绝时的默认文案和历史消息的拼接方式都由框架决定，要逐项检查。',
      ],
      files: ['frameworks/langgraph.ts'],
    },
    {
      title: '4. 审批：needsApproval / interruptions 对比 interrupt / Command',
      text: [
        'Agents SDK：create_ticket 标上 needsApproval: true 后，模型一旦请求调用它，Runner 就暂停整个 run，result.interruptions 里是待审批的工具调用。服务端对每一项调用 state.approve(item) 或 state.reject(item, { message })，然后执行 runner.run(agent, state) 继续。',
        'LangGraph：框架没有“工具需要审批”这个配置。我们在 agent 和 tools 之间加了一个 approve 节点，节点里调用 interrupt(审批请求)。图停下后，结果里会出现 __interrupt__，检查点也保存好了。恢复时用 graph.invoke(new Command({ resume: { [callId]: true } }), { configurable: { thread_id } })，interrupt() 的返回值就是这个决定。',
        '一个容易踩的细节：恢复时，LangGraph 会从头重跑 interrupt 所在的节点，而不是从 interrupt 那一行继续。如果在同一个节点里先建单再 interrupt，恢复时就会再建一次。所以审批节点只做无副作用的事，执行工具放在下一个节点。',
        '拒绝时，两边都要显式指定发给模型的内容。SDK 不传 message 时会用默认英文文案，模型看到的就和手写版不同了。这里统一返回参考项目的 APPROVAL_REJECTED 信封，测试检查模型收到的错误码。',
      ],
      code: {
        title: '暂停 → 审批 → 恢复（节选自 compare.ts）',
        content: `// Agents SDK
let result = await runner.run(agent, question, { context, session });
if (result.interruptions.length > 0) {
  const saved = result.state.toString();                     // 存进数据库
  const state = await restoreState(agent, saved, context);   // 稍后、可能在另一个进程
  for (const item of state.getInterruptions()) approve ? state.approve(item) : state.reject(item, rejectOptions);
  result = await runner.run(agent, state, { session });
}

// LangGraph
await graph.invoke({ messages: [new HumanMessage(question)] }, config);
const pending = await pendingApprovals(graph, config);       // 从 getState 读 interrupt
if (pending.length > 0) {
  const decisions = Object.fromEntries(pending.map((p) => [p.callId, approve]));
  await createTicketGraph(store, model, checkpointer).invoke(new Command({ resume: decisions }), config);
}`,
      },
      files: ['frameworks/compare.ts'],
    },
    {
      title: '5. 状态持久化与身份：谁存什么、恢复时信谁',
      text: [
        'Agents SDK 的 RunState.toString() 会把整个 run 序列化成 JSON，内容包括消息、待审批项、当前 agent 和 context，当前 schema 版本是 1.24。恢复时我们用 RunState.fromStringWithContext(..., new RunContext(当前身份), { contextStrategy: "replace" })，丢掉状态串里存的 user，换成当前登录会话的身份。否则谁拿到这个字符串，谁就能以原员工的身份继续执行。',
        '多轮对话用 Session（这里是 MemorySession）。每次 run 前，SDK 会把历史拼到输入前面。LangGraph 用 checkpointer 按 thread_id 保存全部状态，同一个线程天然是多轮的。我们让 thread_id 等于 Store 里的 runId，这样草稿和工单的归属规则可以原样沿用。',
        '演示里用的 MemorySaver 和 MemorySession 都只在内存里，进程退出就丢失。测试中“重启”的模拟方式是：Agents SDK 序列化成字符串后重新加载；LangGraph 每一步重新编译一个新的图实例，共用同一个 checkpointer。生产环境要换成持久化实现，例如 @langchain/langgraph-checkpoint-postgres、-sqlite，或者自己实现的 Session。另外要处理清理、加密和 schema 升级，手写版里这些问题由事件日志（第 6 章）负责。',
      ],
    },
    {
      title: '6. 重试与重放：框架不会替你保证“只执行一次”',
      text: [
        '有两个测试专门复现重复执行的情况。第一，Agents SDK 把同一个已审批的 RunState 恢复两次，模拟用户双击或两个 worker 抢到同一条任务，create_ticket 确实执行了两次。第二，LangGraph 用审批前的 checkpoint_id 再恢复一次（“时间旅行”），等于重试一个其实已经成功的请求，写工具同样又执行了一次。',
        '两种情况最后都只有一张工单，原因是参考项目的建单工具使用 runId:callId 作为幂等键（第 5 章）。框架提供的是“至少一次”的恢复语义，“恰好一次”要靠工具自己实现。把幂等去掉后再跑这两个测试，就会看到第二张工单。',
      ],
      code: {
        title: 'test/frameworks.test.ts（节选）',
        content: `// 同一个审批状态被恢复两次：工具确实又执行了一次，靠参考项目的幂等键只建一张
assert.match(String((await resume()).finalOutput), /工单已创建/);
assert.equal(store.tickets('acme').length, 1);

// LangGraph：带上审批前的 checkpoint_id 再恢复一次
await graph.invoke(new Command({ resume: { [request.callId]: true } }), { ...old, callbacks: toolStarts(replayed) });
assert.ok(replayed.includes('create_ticket'), '重放确实再次执行了写工具');
assert.equal(store.tickets('acme').length, 1);`,
      },
      files: ['frameworks/test/frameworks.test.ts'],
    },
    {
      title: '7. 追踪与流式输出',
      text: [
        '追踪：Agents SDK 内置 trace / span，默认上传到 OpenAI 的追踪后端。没有 API key 时只打印一条警告并跳过上传。测试和演示里用 setTraceProcessors([...]) 换成本地收集器，所以能断言 function:create_ticket 这类 span。注意 traceIncludeSensitiveData 默认为 true，员工的问题和工单内容会随追踪一起上传，我们显式关掉了。自定义 Model 不会产生 generation span，接真实 provider 才有。',
        'LangGraph 走 LangChain 的回调体系：在 config.callbacks 里传入带 handleToolStart / handleLLMStart 等方法的对象，就能拿到每次工具调用和模型调用。设置 LANGSMITH_TRACING 环境变量后会上传到 LangSmith，也可以换成 OpenTelemetry 导出。',
        '流式输出：Agents SDK 用 runner.run(..., { stream: true }) 和 toTextStream()。LangGraph 用 graph.stream(input, { streamMode: "messages" })，按 [chunk, metadata] 逐段产出，用 metadata.langgraph_node 过滤出 agent 节点的文本。两边都有测试检查“拼接后的片段等于最终回答”。适配器是先收集参考模型的增量、再逐段转发，所以这里测的是接口形状，不是首字延迟。',
      ],
    },
    {
      title: '8. 跑一遍三方对比',
      text: [
        'demo.ts 用同一组 5 步对话（检索、建单并同意、建单并拒绝、另一租户检索、无依据拒答）分别驱动三种实现。回答逐字相同时只打印一份，最后输出模型调用次数、输入 token 和工单数。',
        '回答和工单数完全一致，调用次数相同，但两个框架的输入 token 多了约 85%。原因是两个框架版本每个员工只用一个会话或线程，后面的问题会带上前面所有轮次的历史。手写版是每个问题一个 run，靠第 8 章的上下文策略控制长度。框架让多轮对话变得很容易，也很容易让上下文无限增长。在 Session 或检查点上做裁剪、摘要和过期清理，仍然是你的工作。',
        '代码量（不含空行和注释）：openai-agents.ts 164 行，langgraph.ts 161 行，共用的 shared.ts 43 行。手写的 src/agent.ts 271 行，此外还有审批过期、预算、上下文裁剪和基于事件日志的崩溃恢复。框架版本里约 60 行是模型适配器，接真实 provider 时这部分可以省掉，但上面那些生产能力仍然要补上。',
      ],
      files: ['frameworks/demo.ts'],
      command: 'npm run demo',
      output: `对话记录（三种实现逐字相同时只打印一份）：

[alice] 差旅住宿报销上限是多少
  回答：根据《差旅报销制度》[acme-travel@v2]：差旅住宿报销上限：一线城市每晚 500 元，其他城市每晚 350 元。超出部分需部门负责人审批。报销需在出差结束后 30 天内提交。
[alice] VPN 连不上，帮我提交工单
  审批：提交工单「VPN 连不上，帮我提交工单」 → 同意
  回答：根据《VPN 故障处理指南》[acme-vpn@v1]：VPN 无法连接：先重启客户端并确认账号未锁定。仍无法连接请提交 IT 工单，注明错误码和发生时间。
        工单已创建，编号 TCK-MWKDDU9K-066a。
[alice] 显示器坏了，申请报修
  审批：提交工单「显示器坏了，申请报修」 → 拒绝
  回答：没有找到你有权限查看的相关制度，无法给出确定答案。建议咨询人事或提交工单。
        你拒绝了创建工单，没有提交任何工单。
[bob] 差旅住宿报销上限是多少
  回答：根据《Globex 差旅规定》[globex-travel@v1]：Globex 差旅住宿报销上限：每晚 800 元。
[alice] Q4 预算冻结了吗
  回答：没有找到你有权限查看的相关制度，无法给出确定答案。建议咨询人事或提交工单。

实现                  回答一致  模型调用  输入 token  工单
手写（src/agent.ts）      是           14       4153  1
OpenAI Agents SDK     是           14       7682  1
LangGraph.js          是           14       7682  1

Agents SDK 追踪 span：function:search_knowledge×5  turn×16  agent×7  task×7  function:prepare_ticket×2  function:create_ticket×2`,
      outputNote: '工单编号含时间和随机数，每次运行都不同。token 数来自 mock 模型的估算，只适合横向比较。如果参考项目的 mock 模型或提示词改了，这些数字也会变。',
    },
    {
      title: '9. 对比表',
      text: [
        '控制力：手写版的每个分支都是自己的代码。Agents SDK 的循环是黑盒，只能通过 hooks、toolUseBehavior 和 stopAtToolNames 等配置项调整。LangGraph 的流程图是你自己画的，节点内部完全由你控制，控制力接近手写版。',
        '调试：手写版可以单步执行，事件日志能看到每一步。Agents SDK 出问题时，要在 RunState 的 JSON 和 span 之间来回对照，调用栈深入 SDK 内部。LangGraph 可以用 getState / getStateHistory 查看每个检查点，配合 LangGraph Studio 还能可视化，但 Pregel 运行时的报错比较抽象。',
        '持久化：手写版的事件日志和 SQLite 完全由你决定格式。Agents SDK 提供 RunState 序列化和 Session 接口，存储需要自己实现或使用托管服务。LangGraph 的检查点最完整，有官方 Postgres / SQLite 实现，还能回到任意历史版本，但存储格式由框架决定。',
        '审批：手写版要自己写暂停、恢复、过期和归属校验。Agents SDK 只要一个 needsApproval 配置，也最省事，但审批过期、归属校验仍然要自己做。LangGraph 的 interrupt 最灵活，可以在任何节点、为任何事情暂停，代价是要注意节点会重跑。',
        '可观测：手写版要自己接 OpenTelemetry（第 9 章）。Agents SDK 内置追踪，但默认上传到 OpenAI，需要显式配置。LangGraph 依靠回调和 LangSmith，生态成熟，同样要注意数据出境。',
        '锁定风险：手写版没有锁定。Agents SDK 的 Responses API 风格条目和 RunState 格式都绑定在 SDK 上。LangGraph 绑定 LangChain 的消息类型和检查点格式，迁出成本最高。',
        '升级成本：手写版只受模型 API 变化影响。Agents SDK 仍是 0.x，按语义化版本约定次版本也可能有破坏性变更，RunState 的 schema 也在演进（当前 1.24）。LangGraph 1.x 相对稳定，但 @langchain/core 的 peer 依赖要一起升级。',
      ],
    },
    {
      title: '10. 什么时候用框架，怎样迁移',
      text: [
        '适合手写的情况：流程固定且简单（一个循环加少量工具）；对数据出境、审计和依赖数量有硬性要求；团队需要在面试或排障时能讲清每一行代码。本课程的参考项目属于这一类。',
        '适合 Agents SDK 的情况：主要使用 OpenAI 模型，想快速获得工具循环、审批、handoff、guardrail 和追踪，并能接受 0.x 版本的变化。适合 LangGraph 的情况：流程有明显的分支、循环和多个人工节点，需要长时间运行、断点续跑、回溯历史，或者要编排多个 agent 和子图。',
        '迁移路径：先保留参考项目的工具层（解析、权限、幂等、信封），框架只替换编排层，也就是本章的做法。再用同一组评测和端到端用例做逐字对比（第 7 章的 eval，以及本章的 parity 测试），确认行为一致后再接真实模型。灰度时让两套编排并行运行，比较追踪和工单数。最后才逐步引入框架独有的能力，例如 handoff 和子图。',
        '把框架放在边界之内：业务规则写在工具里，身份由服务端注入，副作用必须幂等。这样以后换框架或者回到手写，只需要重写编排层。',
      ],
    },
  ],
  pitfalls: [
    {
      symptom: '升级小版本后，恢复旧的审批状态报错，或者工具参数格式变了。',
      cause: '框架变化很快。@openai/agents 还是 0.x，RunState 的 schema 版本已经到 1.24；LangGraph 的 peer 依赖 @langchain/core 也在不断变化。用 ^ 范围安装时，每次 npm install 都可能装到不同版本。',
      fix: '锁定精确版本并提交 package-lock.json。升级单独提一个 PR，跑完整的对比测试。持久化的状态里带上版本号，升级前处理完正在等待审批的 run，或者准备迁移脚本。',
    },
    {
      symptom: '模型行为和手写版不一样，比如被拒绝后用英文回复，或者某个可选参数总是被填上。',
      cause: '框架有隐藏的默认值：拒绝时默认发送英文文案；strict 模式把可选字段改成必填；有的配置会自动追加提示词或改写工具结果格式。',
      fix: '把发给模型的完整请求录下来，和手写版逐项比较（本章的 recording 和工具契约测试）。拒绝文案、工具 schema 和系统提示词都要显式配置，并写测试固定下来。',
    },
    {
      symptom: '重试、恢复或回溯之后出现了两张一样的工单。',
      cause: '框架恢复的语义是“至少一次”：同一个审批状态被恢复两次、从旧检查点重放、LangGraph 节点在 interrupt 后从头重跑，都会让写操作再执行一次。',
      fix: '写工具必须幂等（用 runId:callId 之类的稳定键去重）。interrupt 之前不放副作用，审批节点和执行节点分开。恢复操作要加锁或使用条件更新，保证只有一个 worker 能拿到。',
    },
    {
      symptom: '员工的问题和工单内容出现在第三方追踪平台上，或者离线环境里一直打印上传失败的警告。',
      cause: 'Agents SDK 默认把追踪上传到 OpenAI，且 traceIncludeSensitiveData 默认为 true；LangChain 在设置了 LANGSMITH_TRACING 后会上传到 LangSmith。',
      fix: '显式配置追踪：关闭敏感数据，或者用 setTraceProcessors 换成自己的导出器，需要时设置 tracingDisabled。上线前抓包或查看导出器日志，确认数据去了哪里。',
    },
    {
      symptom: '审批恢复后，工单挂到了别的员工名下，或者越权读到了别的租户的数据。',
      cause: '把序列化状态或检查点里存的身份当真了：RunState 字符串里带着 context，LangGraph 状态里如果存了 user，也会随检查点被恢复出来。',
      fix: '身份每次都由服务端注入：Agents SDK 用 fromStringWithContext 配合 contextStrategy: "replace"，LangGraph 放在 config.configurable 里，不写进图状态。审批时再校验草稿是否属于当前员工。',
    },
  ],
  exercises: [
    { id: 't-fw-run', text: '在 frameworks 目录下运行 npm ci、npm test 和 npm run demo，确认 11 个测试都通过，三种实现的回答一致。' },
    { id: 't-fw-idempotency', text: '临时去掉参考项目建单工具的幂等检查，重跑测试，观察哪两个测试先失败，再恢复原样。', detail: '你应该看到“重复恢复”和“检查点重放”两个测试都多出一张工单。这说明“只执行一次”来自工具本身，不是框架提供的。' },
    { id: 't-fw-reject-text', text: '在 Agents SDK 版本里去掉 rejectOptions，用 recording 打印模型收到的拒绝结果，看看默认文案是什么。' },
    { id: 't-fw-trim', text: '给 LangGraph 版加一个裁剪节点，只保留最近 N 轮消息，让 demo 里的输入 token 降到接近手写版，同时回答保持不变。' },
    { id: 't-fw-real-model', text: '把 ReferenceModelProvider 换成真实的 OpenAI provider（或者用 ChatOpenAI 替换 ReferenceChatModel），跑第 7 章的评测集，比较通过率和 token。', detail: '需要 API key，结果不在仓库里。重点检查 strict schema 对 sourceIds 的影响，以及 generation span 是否出现。' },
  ],
  deeper: {
    stageId: 'from-scratch',
    text: '先读第 4–6 章的手写循环、审批和事件日志，再回来看框架替你做了什么、没做什么。',
  },
  interview: [
    { q: '你为什么手写 agent 循环，而不直接用 LangGraph 或 Agents SDK？', a: [
      '我两种都实现过，并且用同一组用例做了对比：回答逐字相同、调用次数相同，框架版本的代码少一些。但审批过期、预算、上下文裁剪、崩溃恢复和幂等仍然要自己写。',
      '手写版没有依赖、数据不出境、每一行都能讲清楚，适合流程简单、合规要求高的场景。流程变成多分支、长时间运行、多个人工节点时，我会选 LangGraph；主要使用 OpenAI 模型并且想快速上线时，选 Agents SDK。',
      '无论用哪种，工具层（权限、幂等、信封）都保持框架无关，这样随时可以迁移。',
    ] },
    { q: 'LangGraph 的 interrupt 和 Agents SDK 的 needsApproval 有什么区别？', a: [
      'needsApproval 是工具级的声明，Runner 在执行这个工具前暂停，恢复时用 state.approve / reject。interrupt 是图里任意节点都可以调用的函数，可以为任何事情暂停，恢复时用 Command({ resume }) 传回值。',
      'interrupt 恢复时会从头重跑整个节点，所以 interrupt 之前不能有副作用。SDK 的审批状态在 RunState 里，需要自己序列化保存；LangGraph 的状态由 checkpointer 自动保存。',
    ] },
    { q: '框架能保证工具只执行一次吗？', a: [
      '不能。重复恢复同一个状态、从旧检查点重放、节点重跑，都会再次执行写工具，我在测试里复现过这两种情况。',
      '“恰好一次”要靠工具幂等（稳定的幂等键加唯一约束），再加上恢复时的并发控制。',
    ] },
    { q: '引入 agent 框架有哪些风险？', a: [
      '版本变化快（0.x，状态格式在变）、隐藏默认值（提示词、拒绝文案、strict schema）、追踪默认上传到第三方、依赖体积大（这里 51 个包、约 114 MB），以及状态格式带来的锁定。',
      '对策：锁定版本，把发给模型的请求录下来做对比测试，显式配置追踪，业务逻辑留在框架之外。',
    ] },
  ],
};
