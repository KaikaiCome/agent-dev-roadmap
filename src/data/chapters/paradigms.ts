import type { Chapter } from '../tutorial';

export const chapter: Chapter = {
  id: 'paradigms',
  part: 'advanced',
  title: '第 28 章 三种工作范式：Agent Loop、Harness 与 Graph',
  summary: '前 27 章一直在用这三种范式，但没有给它们命名，也没有把它们拆开看。本章用零依赖的代码把它们各实现一遍：30 行的 Agent Loop 内核、通过钩子接上去的 Harness、一个按 LangGraph/Pregel 语义实现的约 200 行图运行时，最后把三者组合成“图管流程、节点里跑循环”的混合工单助手。每个结论都有失败实验和测试支撑。',
  minutes: 150,
  outcome: '代码在 course/ticket-agent/src/paradigms：loop.ts（内核）、harness.ts（预算、死循环检测、上下文裁剪、审批、错误信封、检查点、身份校验）、graph.ts（超步、reducer、条件边、扇出扇入、检查点、interrupt、时间旅行、递归上限）、ticket-graph.ts（混合范式），配 15 个测试和一个对比演示。读完你能说清：每种范式由谁决定下一步、失败时会怎样、各自的成本，以及在一个新需求面前该选哪种、怎么组合。',
  concepts: [
    { term: 'Agent Loop（智能体循环）', text: '“问模型 → 执行模型要的工具 → 把结果放回对话 → 再问”，直到模型不再要工具。下一步做什么、什么时候结束，都由模型决定。灵活，能处理没预料到的情况；代价是路径不可预测，步数和成本没有上限。' },
    { term: 'Harness（运行框架 / 外壳）', text: '包在模型和循环外面的那一圈工程：预算、上下文管理、工具权限与审批、错误处理、持久化与恢复、身份、追踪。它不决定“下一步做什么”，只决定“允许做什么、做到什么程度、出了事怎么办”。常见说法是 Agent = Model + Harness。' },
    { term: 'Graph（图 / 显式状态机）', text: '把流程画成节点和边：节点是一段代码（可以调用模型），边决定下一个节点。下一步由代码（路由函数）决定，模型只在节点内部发挥作用。路径可枚举、可测试、可审计；代价是只能处理设计时想到的分支。' },
    { term: '控制权（control flow ownership）', text: '区分三种范式最有用的问题：“下一步由谁决定？”Loop 交给模型，Graph 交给代码，Harness 不参与决定，只设边界。混合范式就是按步骤分配控制权：开放的部分给模型，确定的部分写进图。' },
    { term: '超步（super-step）', text: 'Pregel / LangGraph 的执行单位。同一步要运行的节点并发执行，读同一份状态快照，各自返回要更新的字段；步末统一合并写入、存一个检查点，再算出下一步的节点。' },
    { term: 'Reducer（合并函数）', text: '规定一个字段收到多份写入时怎么合并，比如列表追加、数字相加。同一步里两个节点写同一个没有 reducer 的字段，运行时报 InvalidUpdateError：并发写冲突被显式化，而不是谁后写谁赢。' },
    { term: '检查点（checkpoint）', text: '某个时刻完整、可序列化的状态。有了它才有暂停等人、崩溃后恢复、失败重试和时间旅行。Loop 的检查点是对话历史（加上 harness 自己的状态），Graph 的检查点是“状态 + 下一步要运行的节点”。' },
    { term: '至少一次 + 幂等 = 效果上恰好一次', text: '任何“从检查点恢复”的机制都可能把最后一步再执行一遍（副作用已发生、检查点还没写入时崩溃）。运行时只能保证至少一次；不出现重复的副作用，靠的是工具的幂等键。' },
  ],
  steps: [
    {
      title: '1. 三个词说的不是同一层东西',
      text: [
        '这三个词经常被并列提起，好像是三选一，其实它们回答的是不同的问题。Agent Loop 和 Graph 回答“下一步由谁决定”：Loop 交给模型，Graph 交给代码。Harness 回答的是另一个问题：“模型在什么边界里工作、出了事怎么办”。它和前两者正交，Loop 需要 harness，Graph 的节点里如果跑了 Loop，也需要 harness。',
        '前面的章节其实一直在用它们，只是没有命名。第 2、4 章的 runAgent 是一个 Loop；第 4、5、9、13、15、19–24 章给它加上的预算、审批、事件日志、上下文裁剪、权限和红队防护，合起来就是 harness；第 26 章的 LangGraph 版本是 Graph。本章把这三层拆开，各自用最少的代码实现一遍，让每一层的职责、失败方式和成本都能单独观察。',
        '同一个请求“VPN 连不上，帮我提交工单”，在三种实现下的表现如下。三者都建了一张工单；差别在于审批前有没有副作用（裸循环没有审批，直接建单），以及模型调用次数（混合图把“起草、建单、回复格式”写成了代码，模型调用从 4 次降到 2 次）。后面每一节解释这张表里的一个数字。',
      ],
      files: ['src/paradigms/loop.ts', 'src/paradigms/harness.ts', 'src/paradigms/graph.ts', 'src/paradigms/ticket-graph.ts', 'examples/14-paradigms.ts'],
      command: 'cd course/ticket-agent\nnpm run paradigms',
      output: `同一个请求：「VPN 连不上，帮我提交工单」，员工同意建单

实现                  模型调用  审批前无副作用  工单
裸 Agent Loop         4         否（直接执行）  1
Agent Loop + Harness  4         是              1
Graph（混合）         2         是              1`,
      outputNote: '离线 mock 模型的结果，结论是结构性的（调用次数取决于流程设计，不取决于模型能力）。演示完整输出见第 3、9 节。',
    },
    {
      title: '2. Agent Loop 内核：控制权在模型手里',
      text: [
        'loop.ts 的 agentLoop 只有一个 while(true)，每一轮做三件事：先执行上一条模型消息里还没有结果的工具调用；再调用模型；如果模型没有再要工具，就结束。注意“结束”这个判断：循环本身不知道任务做完了没有，是模型说不再需要工具。这就是 Agent Loop 的本质，也是它的全部风险来源。',
        '第一个设计细节：为什么先执行“还没有结果的工具调用”，而不是调用模型之后立刻执行？因为这样循环可以从任意检查点继续。正常运行时，pendingCalls 返回的是刚刚要的调用；从检查点恢复时，返回的是崩溃前没做完、或者暂停等审批的调用。同一段代码同时处理“继续”和“恢复”，不需要第二条路径。',
        '第二个设计细节：LoopState 只有数据（messages、steps、usage），没有函数、连接和类实例，所以能 JSON 序列化、写进数据库、在另一个进程里读出来接着跑。这是所有可恢复 agent 的前提。如果状态里混进一个数据库连接或一个闭包，暂停和恢复就无从谈起。',
        '第三个设计细节：内核故意什么策略都没有。没有审批，写工具直接执行；没有错误信封，工具抛错就让整个 run 抛错；没有预算，只有一个默认 100 次的保险丝。保险丝不是策略：它的作用只是防止测试里失控的模型把机器跑挂，达到上限时直接抛异常，而不是优雅地结束。所有策略都通过 LoopHooks 的四个钩子从外面接进来，不传钩子，就是最朴素的 Agent Loop。',
      ],
      files: ['src/paradigms/loop.ts'],
      code: {
        title: 'src/paradigms/loop.ts（节选）',
        content: `while (true) {
  // 1. 先执行还没有结果的工具调用：正常时是刚要的；恢复时是崩溃前没做完的
  for (const call of pendingCalls(state.messages)) {
    const decision = hooks.beforeTool?.(call, state) ?? { action: 'run' };
    if (decision.action === 'pause') return { status: 'paused', call, summary: decision.summary };
    // skip：不执行，直接用 decision.result 作为结果（拒绝、策略拦截）
    // run：执行；出错时有 onToolError 就把错误变成结果，没有就抛出
    state.messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
    hooks.checkpoint?.(state);
  }

  // 2. 再问模型
  if (state.steps >= fuse) throw new Error(\`保险丝熔断：模型已经调用了 \${fuse} 次\`);
  const prepared = hooks.beforeModel?.(state);
  if (prepared && 'stop' in prepared) return { status: 'stopped', reason: prepared.stop };
  const response = await model.complete({ messages: prepared?.messages ?? state.messages, tools, signal });
  state.steps += 1;
  state.messages.push(response.message);
  hooks.checkpoint?.(state);

  // 3. 模型不再要工具 = 它认为做完了。“什么时候结束”由模型决定
  if (!response.message.toolCalls?.length) return { status: 'completed', answer: response.message.content };
}`,
      },
    },
    {
      title: '3. 裸循环的四种失败：harness 每一项都是被事故逼出来的',
      text: [
        '理解 harness 最好的办法，是先看没有它会怎样。测试里的前六个用例用同一个内核，分别在“裸跑”和“接上 harness”两种情况下运行，对比结果：',
        '一、越权：模型要 create_ticket，裸循环直接执行，员工根本没确认过。二、失控：一个永远用同样参数调用检索、从不回答的模型，裸循环一直跑到保险丝熔断（演示里是 100 次模型调用，按真实价格这就是一笔账单）；harness 在第 3 次重复时停下，换成 token 预算 500 时，在第 5 次调用后停下（已用 550）。三、脆弱：工具参数不合法时抛出的 ToolError 让裸循环整个崩溃；harness 把它包成 { ok: false, error: { code: "INVALID_ARGUMENTS" } } 交给模型，模型看到错误后自己改正。四、失忆：create_ticket 执行成功之后、结果写入检查点之前进程崩溃，裸循环的状态只在内存里，只能重新发起，新的 runId 意味着新的幂等键，于是多出一张工单；harness 从检查点恢复，再执行一次 create_ticket，幂等键挡住了重复，返回的是同一张工单（duplicate: true）。',
        '第四个实验值得多想一下。harness 恢复后，create_ticket 确实又执行了一次。这不是 bug，而是所有检查点机制的固有性质：副作用和检查点写入不是一个原子操作，中间总有一个窗口。运行时能保证的只是“至少执行一次”，“效果上只有一次”只能靠工具的幂等键。第 5 章把幂等键设计成 runId:callId，恢复时 runId 和 callId 都不变，键也不变，这正是它在这里生效的原因。',
      ],
      files: ['test/paradigms.test.ts', 'examples/14-paradigms.ts'],
      command: 'npm run paradigms',
      output: `失败实验 1：模型每一轮都用同样的参数调用检索，永远不回答
实现                  模型调用  结果
裸 Agent Loop         100       保险丝熔断：模型已经调用了 100 次
Agent Loop + Harness  3         stopped：同一个调用重复了 3 次：search_knowledge

失败实验 2：create_ticket 执行成功后、结果落盘前进程崩溃，然后重启
实现                  重启后怎么做                                   工单
裸 Agent Loop         状态丢失，从头再来（新 runId = 新幂等键）      2
Agent Loop + Harness  从检查点恢复，重跑 create_ticket（completed）  1`,
      outputNote: '崩溃是用 MemoryCheckpointer.crashBeforeSave 模拟的：在“最后一条消息是建单结果”的那次保存之前抛异常。',
    },
    {
      title: '4. Harness ①：钩子为什么挂在这四个时刻',
      text: [
        'Harness 只通过四个钩子影响循环，每个钩子的位置都有理由。beforeModel 在调用模型之前：这是唯一一个“还没花钱”的时刻，所以预算检查、死循环检测、上下文裁剪都在这里。beforeTool 在执行工具之前：这是唯一一个“还没产生副作用”的时刻，所以审批和策略拦截在这里。onToolError 在工具出错时：决定模型看到什么。checkpoint 在状态每变化一次之后：决定崩溃时最多丢多少。',
        '预算有两条：maxSteps（模型调用次数，默认 8）和 maxTokens（输入加输出，默认 60k）。两条都要有，因为它们防的是不同的事：步数防循环，token 防单步过大（比如一次把超长日志塞进上下文）。检查发生在调用之前，所以实际用量可能略超预算一个调用的量，实验里预算 500、停下时已用 550，就是这个原因。要严格不超，需要在调用前预估本次的输入 token（生产版 agent.ts 用 remaining 计算 maxOutputTokens 就是这个思路）。',
        '死循环检测（mostRepeatedCall）统计整个 run 里“工具名 + 参数”完全相同的调用次数，达到 maxRepeats 就停。它比步数预算早得多地发现问题：实验里第 3 次调用就停了，而步数预算要等到第 8 次。为什么是“完全相同”而不是“同一个工具”？因为换了关键词再检索一次是正常行为，同样的参数再来一次，结果不会变，只能说明模型卡住了。生产版 agent.ts 没有这一项，这是本章的练习之一。',
        '上下文裁剪复用第 13 章的 fitContext：超过预算时先清除最旧的工具结果。注意 record.cleared：已经清除的调用会记进检查点，之后保持清除。如果每次都重新计算，前缀会忽长忽短，提示词缓存（第 13 章）就失效了。返回 { messages } 只改变“发给模型的内容”，不修改 state.messages。完整历史还在，审计和恢复都不受影响。',
      ],
      files: ['src/paradigms/harness.ts', 'src/context.ts'],
      code: {
        title: 'src/paradigms/harness.ts：beforeModel',
        content: `beforeModel: (state) => {
  if (state.steps >= maxSteps) return { stop: \`超过最大步数 \${maxSteps}\` };
  const used = state.usage.inputTokens + state.usage.outputTokens;
  if (used >= maxTokens) return { stop: \`超过 token 预算 \${maxTokens}（已用 \${used}）\` };
  const repeated = mostRepeatedCall(state.messages);
  if (repeated && repeated.count >= maxRepeats) return { stop: \`同一个调用重复了 \${repeated.count} 次：\${repeated.name}\` };

  const context = fitContext(state.messages, { budget: contextBudget, overheadTokens: specTokens, alreadyCleared: new Set(record.cleared) });
  if (!context.fits) return { stop: \`上下文超过 \${contextBudget} token\` };
  record.cleared.push(...context.newlyCleared);   // 清除过的保持清除：前缀稳定，缓存才能命中
  return { messages: context.messages };          // 只改发给模型的内容，完整历史不动
},`,
      },
    },
    {
      title: '5. Harness ②：审批是策略，不是工具的行为',
      text: [
        '工具只声明 requiresApproval，内核看不到这个字段，是 harness 的 beforeTool 读它。这个分工很重要：同一个工具在不同场景可以有不同的审批策略（比如测试环境自动批准、高风险租户全部审批），改的是 harness，不是工具。',
        'beforeTool 的决策顺序：工具不存在，直接告诉模型；不需要审批，执行；员工已经同意，执行；员工已经拒绝，不执行，结果是 APPROVAL_REJECTED；参数不合法，不打扰员工，直接把错误交给模型改；以上都不是，暂停，并用工具的 describe 生成人能看懂的摘要。“参数不合法就不去问人”是个容易忽略的细节：让员工审批一个注定失败的操作，既浪费人的注意力，也会训练员工不看内容直接点同意。',
        '员工的决定存在 record.decisions 里，按 callId 索引，而不是写进 messages。它属于 harness，不属于对话：模型不需要看到“员工点了同意”这条消息，只需要看到工具执行的结果。',
        '恢复时的身份：resume(runId, user) 的 user 来自调用方的登录会话，检查点里的 tenantId / userId 只用来比对，不用来代替。如果从检查点读身份，任何能拿到 runId 的人都能以发起人的身份继续这个 run。测试里 bob 审批 alice 的 run，得到的是“不存在”，而不是“无权限”，这样不会泄露 run 是否存在。resume 对非 running 状态什么都不做，所以前端重复点击、消息队列重复投递都是安全的。',
      ],
      files: ['src/paradigms/harness.ts'],
      code: {
        title: 'src/paradigms/harness.ts：beforeTool',
        content: `beforeTool: (call) => {
  const tool = tools.get(call.name);
  if (!tool) return { action: 'skip', result: failure('UNKNOWN_TOOL', \`没有名为 \${call.name} 的工具\`) };
  if (!tool.requiresApproval) return { action: 'run' };
  const decision = record.decisions[call.id];
  if (decision === true) return { action: 'run' };
  if (decision === false) return { action: 'skip', result: failure('APPROVAL_REJECTED', '员工拒绝了这个操作，操作未执行') };
  let args: unknown;
  try {
    args = tool.parse(JSON.parse(call.arguments || '{}'));
  } catch (error) {
    return { action: 'skip', result: toFailure(error) };   // 参数都不合法的写操作，不去打扰员工
  }
  return { action: 'pause', summary: tool.describe?.(args, context) ?? \`\${call.name} \${call.arguments}\` };
},`,
      },
    },
    {
      title: '6. Harness ③：错误信封、检查点与崩溃恢复',
      text: [
        'onToolError 把异常变成结构化结果：ToolError 保留错误码和说明（模型能据此改正），JSON 解析错误变成 INVALID_ARGUMENTS，其他异常一律变成 INTERNAL_ERROR，不把堆栈、SQL、内网地址交给模型。错误信封的目标读者是模型：它要足够具体，让模型知道怎么改；又要足够克制，不泄露内部信息（第 21 章的红队用例专门测这一点）。',
        'checkpoint 在状态每变化一次之后调用：每个工具结果、每条模型消息。MemoryCheckpointer 存的是 JSON 字符串，而不是对象引用，和真实数据库一样，每次读出来都是一份新拷贝，测试才能真正发现“状态不可序列化”或“依赖内存中的引用”这类 bug。',
        'Harness 故意不捕获循环里的异常：异常就当作“进程在这里死掉”，存储里留下的是最后一个检查点，resume 从那里继续。这让崩溃恢复和正常恢复走同一条路径。生产版 agent.ts 更进一步，把能判定的错误（用户取消、模型服务返回 4xx）记成 failed / cancelled，因为有些错误重试也没用（第 4、15 章）。',
        '把 harness 的每一项和生产版 agent.ts 对照，你会发现前面 27 章一直在写 harness，只是它和循环写在了一起：maxSteps / maxTokens 对应 runLoop 里的 budget_exceeded；fitContext 和 cleared 对应 context_trimmed 事件；beforeTool 的暂停对应 approval_requested / approval_resolved 事件，以及第 5 章的审批过期；onToolError 对应 executeToolCall 里的错误信封；checkpoint 对应事件日志（agent.ts 不存快照，而是存事件，每次从事件重建消息，这是检查点的另一种实现，第 4 章）；身份比对对应 resolveApproval 里的租户和发起人检查。拆开的好处是每一项都能单独开关和测试；合在一起的好处是少一层间接。生产代码选了后者，教学代码选了前者。',
      ],
      files: ['src/paradigms/harness.ts', 'src/agent.ts'],
      code: {
        title: 'Harness 的每一项在生产版里的位置',
        content: `harness.ts（本章）               src/agent.ts（第 4–24 章）
--------------------------------------------------------------------------
maxSteps / maxTokens            runLoop：budget_exceeded，按剩余预算限制 maxOutputTokens
maxRepeats（死循环检测）         没有（练习 t-pd-repeat）
fitContext + record.cleared     runLoop：fitContext + context_trimmed 事件
beforeTool → pause              executeToolCall：approval_requested；resolveApproval；过期
record.decisions                approval_resolved 事件
onToolError → toFailure         executeToolCall：ToolError / INTERNAL_ERROR 信封
checkpoint（JSON 快照）          事件日志（events 表），toModelMessages 重建对话
resume 时比对 tenant / user      resolveApproval：租户 + 发起人检查
异常 = 进程死亡                  runAgent：failed / cancelled；第 23 章的租约与接管`,
      },
    },
    {
      title: '7. Graph ①：状态、节点、边与超步',
      text: [
        'graph.ts 按 LangGraph（底层是 Google Pregel 的 BSP 模型）的语义实现了一个最小运行时。状态是一个普通对象；节点是函数，读状态，返回“要改哪些字段”，不直接修改状态；边分两种，普通边固定去向，条件边由路由函数根据最新状态选择去向。一个节点可以有多条普通边，它们指向的节点在下一步并发运行（扇出）。',
        '执行按超步推进：取出这一步要运行的节点，并发执行；每个节点拿到的是状态的一份 structuredClone，读到的都是步首的快照，看不到同一步里其他节点的写入；所有节点完成后，用 reducer 合并写入，存一个检查点，再根据最新状态和边算出下一步的节点。多个节点指向同一个节点时（扇入），它在下一步只运行一次。测试里 a 和 b 同一步运行，b 看到的 x 是 0，而不是 a 写入的 1；join 只运行一次。',
        'Reducer 是并发的代价。同一步里两个节点都写 trace，如果没有定义“列表追加”的 reducer，谁后写谁赢，必然丢数据，所以运行时直接报 InvalidUpdateError，逼你显式决定怎么合并。单节点顺序执行时不需要 reducer，覆盖就是正确语义。',
        '图的结构错误在 compile 时暴露：缺少起点、节点没有出边、边指向不存在的节点。路由函数返回了没有声明的去向，会在运行时报错。条件边可以形成环（比如“检查 → 修改 → 再检查”），所以需要 recursionLimit（默认 25 步，和 LangGraph 一样）：超过时抛 GraphRecursionError，而不是一直跑下去。它对应的就是 harness 的 maxSteps，只是计量单位从“模型调用”换成了“超步”。',
      ],
      files: ['src/paradigms/graph.ts'],
      code: {
        title: 'src/paradigms/graph.ts：一个超步（节选）',
        content: `const settled = await Promise.allSettled(snapshot.next.map((node) =>
  this.#runNode(node, snapshot, config, node === resumeFor ? resumes! : [])));   // 并发，读同一份快照

// 任何一个节点失败：这一步的写入全部丢弃，检查点停在上一步，调用方可以 invoke(null) 重试
const failed = settled.find((r) => r.status === 'rejected' && !(r.reason instanceof GraphInterrupt));
if (failed?.status === 'rejected') throw failed.reason;

// ……（中断处理见下一节）

const state = this.#apply(snapshot.state, updates);   // reducer 合并；无 reducer 的字段被写两次 → InvalidUpdateError
const next = [...new Set(snapshot.next.flatMap((node) => this.#successors(node, state)))];   // 扇入去重
current = this.#g.checkpointer.put({ threadId, parentId: snapshot.id, step: snapshot.step + 1, state, next, ran: snapshot.next });`,
      },
      command: 'node --test test/paradigms.test.ts',
      output: `✔ 裸循环不知道审批：写工具被直接执行；同样的内核加上 harness 后先暂停 (4.8651ms)
✔ 失控的模型：裸循环一直跑到保险丝熔断；harness 在第 3 次重复调用前停下，或在 token 预算用完时停下 (3.1907ms)
✔ 工具出错：裸循环整个 run 崩溃；harness 把错误包成结果交给模型，模型自己改正 (1.5793ms)
✔ 审批：检查点可序列化；换一个 Harness 实例（模拟重启）恢复；只有发起人能审批；重复 resume 不会重复执行 (1.7871ms)
✔ 拒绝：模型收到 APPROVAL_REJECTED，不建单 (1.4792ms)
✔ 副作用之后、检查点之前崩溃：harness 从检查点恢复，工具重跑但幂等键挡住重复；裸循环只能从头再来，多出一张工单 (2.1087ms)
✔ Graph：条件边可以形成环；走不出去的环触发递归上限 (1.1661ms)
✔ Graph：扇出的节点在同一步并发、读同一份快照，扇入的节点只运行一次；没有 reducer 的字段被同时写会报错 (0.4389ms)
✔ Graph：interrupt 暂停整张图；恢复时节点从头重跑，interrupt 之前的副作用执行了两次；多次 interrupt 按顺序取值 (0.5373ms)
✔ Graph：失败的一步不提交，检查点停在上一步，invoke(null) 重试；结构错误在编译时报出 (0.4851ms)
✔ 混合图：提问只走 classify → research → respond，模型调用 2 次，回答带来源 (1.6087ms)
✔ 混合图：报修时 research 与 lookupTickets 并发；停在审批；换一个图实例恢复后只建一张工单 (1.5643ms)
✔ 混合图：拒绝不建单；已有同名未结工单时直接回复，不再请求审批 (2.511ms)
✔ 混合图：时间旅行回到审批检查点再恢复一次，create 节点重跑，幂等键保证仍然只有一张工单 (1.251ms)
✔ 同一个报修请求：纯 Agent Loop（带 harness）调用模型 4 次，混合图 2 次 (1.5918ms)
ℹ tests 15
ℹ pass 15
ℹ fail 0`,
      outputNote: '耗时每次运行都不同。',
    },
    {
      title: '8. Graph ②：检查点、interrupt 与时间旅行',
      text: [
        '每走完一个超步存一个检查点，内容是“状态 + 下一步要运行的节点 + 父检查点”。有了“下一步要运行的节点”，任何检查点都是一个可以继续的位置：某一步有节点抛错，这一步的写入全部丢弃，检查点停在上一步，invoke(null) 就重试这一步；进程重启后，用同一个 threadId 构造新的图实例，也从这里继续。',
        'interrupt() 的实现很朴素：节点调用 ctx.interrupt(payload) 时抛一个特殊异常，运行时捕获它，存一个带 interrupt 字段的检查点（step 不变，next 不变），然后返回 interrupted。resume(value) 从这个检查点重新执行这一步；这一次，被中断节点里第 1 次 interrupt() 直接返回 value，不再抛异常。一个节点可以多次 interrupt：恢复值按调用顺序存在 resumes 数组里，第 n 次调用取第 n 个值。',
        '这带来一个必须记住的性质：恢复时，被中断的节点从头重跑。测试里 ask 节点在两次 interrupt 之前有一个副作用计数，最终执行了 3 次（首次 + 每次恢复）。所以 interrupt 之前不能有副作用，或者副作用必须幂等。ticket-graph.ts 的 approve 节点因此只做一件事：中断并等人，草稿在上一步的 draft 节点里就已经创建并提交到检查点了。（本实现会整步重跑；LangGraph 会保存同一步里其他已成功节点的写入，即 pending writes，恢复时只重跑被中断的节点。结论相同：被中断的节点本身一定重跑。）',
        '时间旅行：resume 时给一个历史 checkpointId，就从那个检查点重新执行，产生一条新的分支（parentId 指向同一个父节点）。它适合调试（“如果当时员工拒绝了会怎样”），也适合人工纠错。代价是：分支上的写节点会再执行一次。测试里从审批检查点恢复两次，create 节点执行了两次，因为幂等键是 runId:create，两次拿到的是同一张工单。这再次说明：恰好一次来自工具，不来自运行时。',
        '最后是身份。TicketConfig { user, runId } 每次 invoke / resume 由服务端传入，通过 ctx.config 交给节点，不写进状态，所以检查点里没有身份，也就无法通过篡改检查点冒充别人。这和 harness 里“身份来自调用方，检查点只用来比对”是同一条原则（第 5 章），LangGraph 里对应 config.configurable。',
      ],
      files: ['src/paradigms/graph.ts'],
      code: {
        title: 'src/paradigms/graph.ts：interrupt 的实现',
        content: `// 节点里：第 n 次调用 interrupt() 时，有第 n 个恢复值就直接返回，否则抛出中断
interrupt: <T>(payload: unknown): T => {
  const index = calls++;
  if (index < resumes.length) return resumes[index] as T;
  throw new GraphInterrupt(name, payload, resumes);
},

// 运行时：捕获中断，存一个“同一步、带 interrupt”的检查点
const saved = this.#g.checkpointer.put({
  threadId, parentId: snapshot.id, step: snapshot.step, state: snapshot.state, next: snapshot.next, ran: [],
  interrupt: { node: pause.node, payload: pause.payload, resumes: pause.resumes },
});

// resume：从这个检查点重跑这一步，把新的值追加到 resumes
return this.#execute(from, options.config, [...from.interrupt.resumes, value]);`,
      },
    },
    {
      title: '9. 混合范式：图管流程，节点里跑循环',
      text: [
        '真实项目很少是纯 Loop 或纯 Graph。ticket-graph.ts 是最常见的组合：外层用图管业务阶段，某些节点内部跑一个带 harness 的 Agent Loop。核心设计决定是：哪些步骤交给模型，哪些写死在代码里。',
        '开放的部分交给模型：research 节点里是一个完整的 Harness，模型自由决定检索几次、怎么组织回答。但它只拿到只读的 knowledgeTool，碰不到建单。确定的部分写成节点和边：是不是报修（classify，用规则，便宜、确定、可测）、要不要查重（lookupTickets + draft）、必须审批（approve）、建单（create，幂等键 runId:create）、回复格式（respond）。这些步骤模型无法绕过。注意 classify 用的是规则；如果换成模型分类，也应该让模型输出受 schema 约束的枚举值（第 24 章），路由仍然由代码根据这个值决定。',
        '报修路径上，research 和 lookupTickets 在同一步并发运行（扇出），都指向 draft（扇入）。两个节点都写 trace 和 modelCalls，所以这两个字段定义了 reducer。trace 记录的是“节点读取的检查点的 step:节点名”：0:classify、1:research、1:lookupTickets、2:draft，然后在审批处中断；恢复后是 3:approve、4:create、5:respond。',
        '为什么模型调用从 4 次降到 2 次？纯 Loop 里，模型要依次决定“检索 → 起草 → 建单 → 回答”，每个决定都是一次调用。混合图里，“起草 → 审批 → 建单 → 回复”是确定的，写成了代码，模型只负责“检索 → 回答”。这是混合范式最直接的收益：更便宜、更快、路径可审计。代价也要看清：draft 节点的标题是 question.slice(0, 40)，不如模型起的标题好；用户说“顺便帮我把上周那张工单关了”，这张图没有这条边，只能答非所问。确定性是用灵活性换来的。',
      ],
      files: ['src/paradigms/ticket-graph.ts', 'examples/14-paradigms.ts'],
      command: 'npm run paradigms',
      output: `Graph 的检查点历史（每走完一步存一个；在审批处中断时多存一个）：
检查点  step  刚运行完的节点            下一步
#1      0     （输入）                  classify
#2      1     classify                  research, lookupTickets
#3      2     research + lookupTickets  draft
#4      3     draft                     approve
#5      3     （approve 中断）          approve
#6      4     approve                   create
#7      5     create                    respond
#8      6     respond                   END

流程图（Mermaid，可粘贴到 https://mermaid.live 查看）：
flowchart TD
  __start__ --> classify
  classify -.-> research
  classify -.-> lookupTickets
  research -.-> draft
  research -.-> respond
  lookupTickets --> draft
  draft -.-> approve
  draft -.-> respond
  approve -.-> create
  approve -.-> respond
  create --> respond
  respond --> __end__`,
      outputNote: '实线是固定边，虚线是条件边。#5 和 #4 的 step 相同：中断检查点不前进，只记录“在哪里、为什么停下”。',
    },
    {
      title: '10. 怎么选，以及业界产品分别是什么',
      text: [
        '先问三个问题。一、路径能不能提前画出来？能画出来，而且画出来的图不超过十几个节点，用 Graph；画不出来（编码、调研、排障这类开放任务，下一步取决于上一步看到了什么），用 Loop。二、出错的代价有多大？涉及钱、权限、对外发送的步骤，即使整体用 Loop，也要把这些步骤从模型手里拿出来，变成固定节点或者 harness 里的强制审批。三、要不要长时间运行、多次人工介入？要的话，检查点和恢复是必需品，不管选哪种。',
        '无论选哪种，harness 都绕不过去。Graph 不会自动给你预算、上下文裁剪和错误信封，节点里一旦跑了循环，这些都要有；Loop 更是完全依赖 harness 兜底。一个经验法则：模型能力越强，越可以把控制权交给它（Loop 加厚 harness）；流程越受监管，越应该把控制权留在代码里（Graph）。二者并不对立，混合范式就是按步骤分配控制权。',
        '用这个框架看业界产品：Claude Code、Codex CLI 这类编码 agent 是“Loop + 很厚的 harness”，下一步完全交给模型，harness 负责权限模式、上下文压缩、沙箱、钩子和子 agent（第 19、20 章做过简化版）。OpenAI Agents SDK 的 Runner 是 Loop，needsApproval、guardrails、session、tracing 是它提供的 harness 组件。LangGraph 是图运行时，它的预置 ReAct agent 是“一个调用模型的节点 + 一个执行工具的节点 + 一条条件回边”，即在图里表达 Loop。Anthropic 的《Building effective agents》把这条线称为 workflows（预定义路径）和 agents（模型自主决定路径），建议从最简单的方案开始，只在确实需要时才增加自主性。',
        '最后回到这门课的参考项目：它是“Loop + 生产级 harness”，因为员工的问题是开放的（问政策、查日志、报修混在一起），而高风险的写操作已经被 harness 的强制审批和幂等管住了。如果业务演进出固定的多阶段审批流（比如采购：申请 → 主管 → 财务 → 下单），那一段就应该改写成图，让 Loop 退回到节点里只负责理解和检索，这正是第 9 节的形状。',
      ],
      code: {
        title: '选型速查',
        content: `                    Agent Loop              Graph                     混合（图套循环）
下一步由谁决定       模型                     代码（路由函数）            按步骤分配
适合                 开放任务：编码、调研、排障  固定流程：审批流、表单、ETL   大多数业务 agent
路径                 不可预测                 可枚举、可画图、可测试        外层可枚举，节点内开放
模型调用             多（每个决定一次）         少（只在节点内）             居中
主要风险             失控、越权、成本           僵化、分支爆炸               边界划分错误
必需的 harness       全部                     节点里有循环时需要            节点内的循环需要
人工介入             工具级审批                interrupt 节点               interrupt 节点 + 工具级审批
恢复语义             从对话历史继续             从超步检查点继续             两层检查点`,
      },
    },
  ],
  pitfalls: [
    {
      symptom: '恢复审批之后，邮件、通知或扣费发生了两次。',
      cause: '在 interrupt() 之前做了副作用。恢复时被中断的节点从头重跑，副作用再执行一次。Agent Loop 也有同样的问题：在检查点写入之前崩溃，恢复时工具会重跑。',
      fix: '审批节点只做中断；副作用放到上一个节点（已经提交到检查点）或下一个节点。所有写操作都带稳定的幂等键（runId + 固定的 callId），本章的 create 节点就是这样在时间旅行下仍然只建一张工单。',
    },
    {
      symptom: '并发分支合并后，列表里少了几条，或者偶尔报 InvalidUpdateError。',
      cause: '同一个超步里多个节点写了同一个字段。没有 reducer 时，“后写的赢”会悄悄丢数据（所以本章和 LangGraph 都直接报错）；有 reducer 但写成了覆盖，也会丢。',
      fix: '画出每一步哪些节点会并发，为它们共同写的字段定义 reducer（追加、求和、按 id 合并）。不需要共享的字段就不要共享：每个分支写自己的字段，在扇入节点里合并。',
    },
    {
      symptom: '重启后恢复的 run 用了错误的身份，或者别人拿到 runId 就能继续这个 run。',
      cause: '把身份存进了循环状态或图状态，恢复时从检查点读出来直接使用。检查点是数据，可能被篡改，也可能在别人的请求里被加载。',
      fix: '身份每次由登录会话传入（Harness.resume 的 user 参数、图的 config），检查点里最多存 tenantId / userId 用来比对。比对失败时返回“不存在”，不泄露 run 是否存在。',
    },
    {
      symptom: '加了 maxSteps 预算，账单还是偶尔失控；或者 agent 在第 8 步才停下，前 7 步都在做同一件事。',
      cause: '预算只是兜底，发现问题太晚；token 预算在调用前检查，单次调用可以超出很多（比如一次塞进超长日志）。',
      fix: '叠加多道防线：重复调用检测（第 3 次就停）、token 预算、按剩余预算限制 maxOutputTokens、工具结果截断（第 13 章）。在指标里记录 stopped 的原因，按原因分别告警。',
    },
    {
      symptom: '图越画越大：每个新需求都加一个节点和一组条件边，最后没人看得懂。',
      cause: '把本该交给模型的开放判断硬编码成了分支。Graph 的优势是确定性，用它去表达开放问题，只会得到分支爆炸。',
      fix: '只把确定的、有业务约束的步骤（审批、写操作、合规检查）画成节点，开放部分收进一个“节点内的 Agent Loop”，用只读工具和 harness 约束它。定期用 toMermaid 生成图，节点超过十几个就该重新审视边界。',
    },
    {
      symptom: '从检查点恢复时报错，或者恢复后行为和暂停前不一致。',
      cause: '状态里有不可序列化的东西（类实例、Date、函数、连接），或者依赖了内存里的引用。内存实现的检查点存的是对象引用时，测试可以通过，换成数据库后才失败。',
      fix: '状态只放纯数据。测试用的检查点也要像数据库一样存 JSON 字符串（本章的 MemoryCheckpointer、MemoryGraphCheckpointer），并在测试里用新的实例恢复，模拟重启。',
    },
  ],
  exercises: [
    { id: 't-pd-run', text: '运行 node --test test/paradigms.test.ts 和 npm run paradigms，确认 15 个测试通过，并能解释演示里每一张表的每一个数字。' },
    { id: 't-pd-no-idempotency', text: '临时去掉 create_ticket 的幂等检查，重跑本章测试，记录哪些用例失败、多出了几张工单，再恢复原样。', detail: '应该至少看到“副作用之后、检查点之前崩溃”和“时间旅行”两个用例失败。这说明 harness 的检查点和图的检查点都只能保证至少一次。' },
    { id: 't-pd-repeat', text: '把 harness.ts 的死循环检测移植到生产版 src/agent.ts：同样的工具名 + 参数出现 3 次就以 budget_exceeded 结束，并补一个测试。', detail: '提示：从事件日志里的 tool_started 事件统计，而不是从内存里的消息统计，这样恢复后的 run 也能正确计数。' },
    { id: 't-pd-side-effect', text: '在 ticket-graph.ts 的 approve 节点里、interrupt 之前调用一次 prepare_ticket，观察恢复后多出的草稿，然后把它改回来。', detail: '这是“interrupt 之前不能有副作用”的直接证据。草稿多了不会多建工单（create 只用 state.draftId），但真实系统里那可能是一封多发的邮件。' },
    { id: 't-pd-loop-in-graph', text: '只用 graph.ts 实现一个纯 Agent Loop：一个 callModel 节点、一个 runTools 节点、一条“有工具调用就回到 runTools，否则到 END”的条件边，跑通 mock 模型的报修流程。', detail: '这就是 LangGraph 预置 ReAct agent 的结构。对比一下：每轮循环变成了两个超步，recursionLimit 现在同时承担了 maxSteps 的职责。' },
    { id: 't-pd-pending-writes', text: '改进 graph.ts：中断时保存同一步里其他已成功节点的写入（pending writes），恢复时只重跑被中断的节点，并补一个测试证明并发的兄弟节点不会重跑。' },
  ],
  deeper: {
    stageId: 'from-scratch',
    text: '回到第 2、4、5 章重读 runAgent、审批和事件日志，用本章的三个词给每一段代码标注：这一行属于 Loop、Harness 还是（隐含的）Graph。',
  },
  interview: [
    { q: 'Agent Loop、Harness、Graph 三者是什么关系？', a: [
      'Loop 和 Graph 回答“下一步由谁决定”：Loop 交给模型，Graph 交给代码里的路由函数。Harness 回答“模型在什么边界里工作、出事怎么办”：预算、上下文、审批、错误信封、检查点、身份，它和前两者正交。',
      '我实现过三者的最小版本：Loop 内核只有一个 while 循环和四个钩子，harness 通过钩子接入；图运行时按 Pregel 超步执行。实际项目常常是混合的：图管业务阶段，节点内跑带 harness 的 Loop，只给它只读工具。',
    ] },
    { q: '什么时候用 Graph，什么时候用 Agent Loop？', a: [
      '路径能提前画出来、有合规要求、需要可审计时用 Graph；任务开放、下一步取决于上一步看到了什么时用 Loop。',
      '更常见的是按步骤分配控制权：涉及钱、权限、对外发送的步骤写成固定节点，理解和检索交给节点内的 Loop。我在同一个报修流程上测过，混合方案的模型调用从 4 次降到 2 次，代价是失去了处理计划外请求的能力。',
    ] },
    { q: '一个生产级的 agent harness 至少要有什么？', a: [
      '预算（步数和 token，最好加重复调用检测）、上下文管理（裁剪，且已裁剪的保持裁剪以利于缓存）、工具权限和人工审批（在执行前，参数不合法时不打扰人）、错误信封（给模型可行动的错误码，不泄露内部信息）、可序列化的检查点和恢复、恢复时用会话身份而不是检查点里的身份、追踪。',
      '每一项都对应一类事故：越权、失控、账单、崩溃后状态丢失、重复副作用、冒用身份。',
    ] },
    { q: 'LangGraph 的 interrupt 恢复后为什么会重复执行代码？怎么处理？', a: [
      'interrupt 通过抛出特殊异常暂停，恢复时从检查点重新执行被中断的节点，节点从头运行，第 n 次 interrupt() 直接返回第 n 个恢复值。所以 interrupt 之前的代码会再执行一次。',
      '处理方式：审批节点只做中断，副作用放在前后的节点；所有写操作带稳定的幂等键。时间旅行、失败重试也会重放写节点，同样靠幂等键兜底。',
    ] },
    { q: 'Agent 系统能做到 exactly-once 吗？', a: [
      '运行时做不到。副作用和检查点写入不是原子的，中间崩溃就会在恢复时重做，所以运行时只能保证至少一次。',
      '效果上的恰好一次 = 至少一次 + 幂等：幂等键要在重试和恢复之间保持稳定（比如 runId:callId），并有唯一约束。我在测试里模拟过“建单成功、检查点未写入”时崩溃，带检查点的 harness 恢复后只有一张工单，裸循环从头再来多出一张。',
    ] },
  ],
};
