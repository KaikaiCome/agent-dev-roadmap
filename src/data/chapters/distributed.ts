import type { Chapter } from '../tutorial';

export const chapter: Chapter = {
  id: 'distributed',
  part: 'advanced',
  title: '第 23 章 分布式运行：任务队列、租约、栅栏令牌与 Outbox',
  summary: '把参考项目从“一个进程里边收请求边跑 Agent”改成“API 只负责入队，多个 worker 进程从同一个 SQLite 文件里领任务”，不引入任何依赖。领任务用带过期时间的租约，worker 定期续约，崩溃后租约过期由别人接手，重试次数用完进入死信。每次领取发一个递增的栅栏令牌，所有写入都比对令牌，卡住后醒来的“僵尸” worker 写不进任何东西。工单创建和通知用事务性 outbox 写在同一个事务里，由投递器至少一次投递、消费端去重。再加上按租户的并发上限和排队上限。最后用一个会随机 kill -9 和冻结 worker 的混沌脚本验证：没有丢失的 run，没有重复的工单。章末讨论 SQLite 的边界，以及迁移到 Postgres、Redis Streams 和持久化工作流引擎时这些概念分别对应什么。',
  minutes: 240,
  outcome: '设置 RUN_MODE=queue 后，npm run server 只入队，npm run worker 可以开任意多个进程执行，其中任何一个被 kill -9 或卡住，它的 run 都会被别人接手并且只生效一次；不设置时行为和以前完全一样。npm run chaos 输出双写对比和混沌测试报告，关掉栅栏令牌时能看到不变量被破坏。新增 8 个测试。',
  concepts: [
    { term: '租约（lease）', text: '带过期时间的锁：worker 领到任务时写下“我是谁、租到几点”，执行期间定期续约（心跳）。worker 崩溃后不再续约，租约过期，其他 worker 就可以接手。租约只解决活性（任务不会因为某个 worker 死掉而永远卡住），不保证同一时刻只有一个 worker 在干活——旧 worker 可能只是暂停了，并没有死。' },
    { term: '栅栏令牌（fencing token）', text: '每次领取时发一个单调递增的号码，持有者的每次写入都带上它，存储端拒绝号码比当前小的写入。旧 worker 醒来后拿着过期的号码，什么都写不进去。租约保证活性，令牌保证正确性，两者缺一不可。概念来自 Martin Kleppmann 对分布式锁的分析。' },
    { term: '事务性 outbox', text: '要“改数据库并且通知外部系统”时，不在业务代码里直接调外部 API，而是在同一个数据库事务里往 outbox 表写一条消息；另一个投递器读 outbox，投递成功后标记完成。数据库状态和“要发的消息”要么都在，要么都不在，不会出现改了库但没通知、或通知了但库回滚的情况。' },
    { term: '至少一次 + 幂等 = 效果上恰好一次', text: '网络上不存在“恰好一次投递”：投递方收不到确认时，无法区分“对方没收到”和“对方收到了但确认丢了”，只能重发。能做到的是至少一次投递，再由消费端按消息 id 去重，让重复投递不产生重复效果。' },
    { term: '背压（backpressure）', text: '下游处理不过来时，让上游慢下来或被拒绝，而不是无限堆积。本章有两层：每个租户同时执行的 run 有上限（公平，不让一个大租户占满所有 worker），每个租户排队的 run 也有上限（满了 API 直接返回 429）。' },
  ],
  steps: [
    {
      title: '为什么要队列：单进程模式的天花板',
      text: [
        '到目前为止，`npm run server` 收到请求后在同一个进程里执行 Agent。第 4 章的事件日志加上 `recover()` 能在进程重启后把中断的 run 接着跑，第 15 章做了限流和并发控制。这在一台机器、一个进程时够用，但有三个问题：① 想加机器或多开进程时，两个进程启动时都会去 recover 同一批 run；② 一个慢 run 占着 API 进程的事件循环和内存，API 和执行无法分开扩容；③ 进程挂掉后，要等它重启才能恢复，期间这些 run 无人处理。',
        '解决办法是把“接收请求”和“执行”拆开：API 把 run 写进一张持久化的队列表就返回，任意多个 worker 进程从表里领任务执行。难点不在“拆开”，而在拆开以后所有分布式系统都会遇到的问题：worker 会崩溃、会卡住、两个 worker 会以为自己都持有同一个任务、写数据库和调外部 API 不在同一个事务里。本章逐个处理这些问题，并用混沌测试证明处理对了。',
        '设计约束和前面一样：零依赖，只用 Node 自带的 node:sqlite；默认关闭，只有设置 `RUN_MODE=queue` 才启用，所以前面所有章节的输出不变。多个进程共享同一个 SQLite 文件：存储层打开了 WAL（读写可以并发），这一章又加了 busy_timeout——写锁被别人占着时等最多 5 秒，而不是立即报 `database is locked`。',
      ],
      files: ['src/store.ts', 'src/config.ts', 'src/main.ts', 'src/server.ts'],
    },
    {
      title: '队列表与租约：一条 UPDATE … RETURNING 领任务',
      text: [
        '`run_queue` 表每个 run 一行：状态（queued 排队 / leased 执行中 / parked 等审批 / done / dead 死信）、租户、尝试次数、令牌、持有者、租约到期时间、可执行时间（用于退避）。API 用 `queue.submit()` 在一个事务里同时创建 run 和入队，不会出现“run 建好了但没入队”的孤儿。',
        '领取是一条 `UPDATE … WHERE run_id = (SELECT … LIMIT 1) RETURNING …`。候选包括排队中且到了可执行时间的，以及租约已经过期的——后者就是“接手别人的任务”。SQLite 的写语句在读之前就拿到了写锁，整条语句是原子的，两个进程不可能领到同一行。Postgres 上的等价写法见第 9 步。',
        'worker 执行期间每隔租约时长的 1/3 续约一次：`UPDATE … SET lease_until = ? WHERE run_id = ? AND fence = ?`。影响行数为 0 说明租约已经被别人拿走，worker 立即用 `LEASE_LOST` 中止自己的 run。续约间隔要明显短于租约时长，否则一次 GC 停顿或一次慢查询就会让健康的 worker 丢租约。',
        '执行结束时 `complete()` 按 run 的状态处理队列行：结束了就是 done；停在等审批就是 parked（不占 worker，员工批准后由 API 用 `resumeAfter()` 重新入队）；还在 running（例如 worker 收到 SIGTERM 优雅退出）就放回队列，并且把这次尝试次数退回去，正常重启不算失败。执行抛异常走 `fail()`：按指数退避重新排队，次数用完进入死信，run 标记为 failed，而不是永远显示“执行中”。领取时也会顺手把“租约过期且次数已用完”的行移进死信，防止一个每次都把 worker 弄崩的 run（毒消息）无限循环。',
      ],
      files: ['src/distributed/queue.ts', 'src/distributed/worker.ts', 'src/worker.ts'],
      code: {
        title: '领取任务（src/distributed/queue.ts）',
        content: `UPDATE run_queue
SET state = 'leased', owner = :owner, lease_until = :until,
    fence = fence + 1, attempt = attempt + 1, updated_at = :now
WHERE run_id = (
  SELECT q.run_id FROM run_queue q
  WHERE ((q.state = 'queued' AND q.available_at <= :now)       -- 排队中
      OR (q.state = 'leased' AND q.lease_until < :now))         -- 别人的租约过期了
    AND <这个租户的在途数> < :limit                              -- 租户并发上限
  ORDER BY <这个租户的在途数>, q.available_at, q.enqueued_at   -- 在途少的租户优先
  LIMIT 1
)
RETURNING run_id, tenant_id, user_id, fence, attempt, lease_until`,
      },
    },
    {
      title: '僵尸 worker：只有租约为什么不够',
      text: [
        '设想 worker A 领到 run 1，租约 30 秒。A 在第 5 秒进入一次很长的 GC 停顿，或者所在机器和数据库之间断网了 40 秒。第 30 秒租约过期，worker B 接手 run 1，重新执行，创建了工单，把 run 标记为 completed。第 45 秒 A 醒了：它不知道自己睡过，接着执行——再创建一张工单，再把 run 状态写成它自己的结果。',
        '“写之前先检查租约还在不在”救不了：检查和写入之间 A 仍然可能停顿，检查通过时租约是有效的，写入时已经不是了。“检查 owner 是不是我”也不行：A 领取、过期、又被 A 自己重新领到（同一个进程的另一个并发槽），owner 一样，旧的那一路照样能写。本质上，任何依赖“持有者自己判断自己还有没有资格”的方案都不可靠，因为持有者无法感知自己停顿过。',
        '栅栏令牌把判断移到存储端：每次领取 `fence = fence + 1`，A 拿到 7，B 接手时拿到 8。之后每次写入都带着令牌，存储端只接受和当前值相同的令牌，A 拿着 7 写，被拒绝。判断发生在写入的同一个原子操作里，中间没有空隙。注意这里不比较时间：即使 A 的时钟走得很不准，结论也不变。',
      ],
      code: {
        title: '时间线',
        content: `t=0    A 领取 run 1          fence = 7, lease_until = 30
t=5    A 停顿（GC / 断网）
t=30   租约过期
t=31   B 领取 run 1          fence = 8
t=40   B 创建工单、完成 run   写入带 fence 8 → 通过
t=45   A 醒来，创建工单       写入带 fence 7 → 拒绝（FENCED）
       A 写 run 状态           写入带 fence 7 → 拒绝（FENCED）`,
      },
    },
    {
      title: '把栅栏放进存储层：TEMP 触发器',
      text: [
        '最直接的做法是在每个写 run 状态、事件、草稿、记忆、outbox 的 SQL 后面加 `AND fence = ?`。问题是写路径散落在 agent.ts、store.ts、工具里，而且这些代码根本不知道队列存在，漏一处就是一个洞。',
        '本章的做法：worker 的数据库连接上建一张临时表 `fence_ctx`，领取时写入“我持有 run X 的第 N 号令牌”；再为 runs 的 UPDATE 和 events、drafts、memories、outbox 的 INSERT 建临时触发器，写入的 run 在 fence_ctx 里有记录、且队列里的当前令牌和它不同时，`RAISE(ABORT, \'FENCED: …\')` 中止整个事务。TEMP 对象只存在于这个连接，API 进程和审批者的连接没有 fence_ctx 记录，完全不受影响；agent.ts 一行没改，所有写路径自动受保护。',
        '中止的是整个事务，这很关键：工单和它的 outbox 消息在同一个事务里，outbox 的插入被栅栏拒绝时，工单也一起回滚，不会留下一张没有通知的工单。被拒绝的错误在 runAgent 里会被当成普通错误，它接着尝试把 run 标记为 failed——这一步同样被拒绝，所以错误最终抛出 runAgent，worker 识别出 FENCED，记一条 fenced 事件后放弃这个 run，不当作故障。',
        '测试里用一个手动推进的时钟模拟停顿：A 领取后时钟拨过租约，B 接手并完成，然后让 A 继续执行。开着栅栏，A 的每一次写入都被拒绝，工单只有 B 那一张；用 `fencing: false` 构造同样的队列（只按 owner 检查队列操作），A 写出了第二张工单，run 的状态被覆盖，事件日志里有两个 run_finished。这个测试同时证明了 bug 存在和修复有效。',
      ],
      files: ['src/distributed/queue.ts', 'test/distributed.test.ts'],
      code: {
        title: '栅栏触发器（以 events 为例）',
        content: `CREATE TEMP TABLE IF NOT EXISTS fence_ctx (run_id TEXT PRIMARY KEY, fence INTEGER NOT NULL);

CREATE TEMP TRIGGER IF NOT EXISTS fence_events BEFORE INSERT ON main.events
WHEN EXISTS (SELECT 1 FROM temp.fence_ctx c JOIN main.run_queue q ON q.run_id = c.run_id
             WHERE c.run_id = NEW.run_id AND q.fence != c.fence)
BEGIN SELECT RAISE(ABORT, 'FENCED: stale fencing token'); END;`,
      },
    },
    {
      title: '写库再调 API：丢通知还是重复通知，二选一',
      text: [
        '创建工单后要通知 IT 值班（webhook、IM、邮件）。直觉写法是先写库再调 API。进程恰好在两步之间崩溃时，工单已经在库里，重试时幂等键发现工单已存在，直接返回——通知永远不会发出。反过来先调 API 再写库，崩溃后重试会再调一次 API，通知重复。把 API 调用放进数据库事务里也不行：事务可以回滚，HTTP 请求不能。',
        '`npm run chaos` 的第一部分用确定性模拟把这件事量化：1000 张工单，每张在两步之间有 5% 的概率崩溃。A 写法丢了 52 条通知，B 写法重复了 83 条。C 是 outbox：工单和“要发的消息”在同一个事务里写入，投递器投递失败或投递后崩溃都会重发（投递 1061 次），消费端按消息 id 去重，最终每张工单恰好生效一次。',
        '`withTicketOutbox(tools, outbox)` 包装 create_ticket 工具：在一个事务里调用原来的工具并写 outbox 消息，消息 id 由工单 id 派生，重试时 `INSERT OR IGNORE` 不会产生第二条。投递器 `startDispatcher` 用和 run 队列同样的租约方式领取消息（多个 worker 都可以跑投递器），成功就 ack，失败按退避重试，次数用完进死信。`webhookDelivery(url)` 把消息 id 放进 `Idempotency-Key` 请求头，接收方用它去重；本地演示用 `Inbox`，它在自己的数据库里先插入消息 id 再执行效果，同一事务里完成。',
        '消费端去重必须和“产生效果”在同一个事务里，否则又回到了双写问题：先记“处理过”再执行，崩溃会丢；先执行再记，崩溃会重复。如果效果在外部系统里（比如发短信），就要依赖对方支持幂等键，或者接受极少数重复。',
      ],
      files: ['src/distributed/outbox.ts'],
      command: 'npm run chaos',
      output: `== 第一部分：为什么不能“写库然后调 API” ==

每张工单在危险时刻有 5% 概率崩溃，崩溃后重新执行（共 1000 张）
写法                      工单  收到通知  丢失  重复  投递次数
A 先写库，再调通知 API    1000  948       52    0     -
B 先调通知 API，再写库    1000  1000      0     83    -
C outbox + 消费端去重     1000  1000      0     0     1061`,
      outputNote: '这是同一条命令输出的前半部分，后半部分见第 7 步。模拟用固定种子（--seed 23），每次结果相同。',
    },
    {
      title: '背压与公平：租户并发上限和排队上限',
      text: [
        '没有公平性时，队列按入队时间先进先出：某个租户一次提交 500 个 run，接下来所有 worker 都在为它干活，其他租户的单个请求要排到最后。领取 SQL 的两个条件解决这件事：这个租户当前的在途数（租约未过期的 leased 行）必须小于 `TENANT_MAX_INFLIGHT`；候选按在途数从少到多排序，在途为 0 的租户总是先被服务。',
        '排队上限 `TENANT_MAX_QUEUED`：入队时这个租户排队中的 run 已经达到上限，`submit()` 返回失败，API 返回 429 和提示。这是背压：与其让队列无限增长、每个请求都等很久再超时，不如尽早拒绝，让客户端退避或提示用户稍后再试。',
        '`queue.stats()` 给出排队数、在途数、租约已过期还没被接手的数量、等审批数、死信数、最老排队任务等了多久，以及每个租户的排队和在途数。worker 每 30 秒把它写进日志。告警该看的是“最老排队时间”和“死信数”，而不是排队数本身：排队 1000 个但 10 秒内都能被处理是健康的，排队 10 个但最老的已经等了 5 分钟说明 worker 全挂了或者全卡在某个租户上限上。',
      ],
      files: ['src/distributed/queue.ts', 'src/server.ts'],
    },
    {
      title: '混沌测试：随机 kill -9 和冻结 worker',
      text: [
        '`npm run chaos` 的第二部分启动 4 个 worker 子进程（每个并发 3），提交 200 个 run，其中一半会创建需要审批的工单。为了让故障真的落在执行中间，mock 模型每次调用加了 20–80ms 延迟，租约设为 600ms，通知服务有 10% 的失败率，并且处理完到返回响应之间有 40ms 延迟（进程在这段时间被杀就会重复投递）。',
        '每 400ms 随机挑一个 worker：一半概率 `SIGKILL`（kill -9，进程没有任何机会清理，随后启动一个新的补上），一半概率让它冻结 1500ms（用 `Atomics.wait` 阻塞整个事件循环，心跳也停了，模拟 GC 停顿或断网）。冻结结束后它会接着执行——这正是僵尸 worker。父进程充当审批者，只批准队列里处于 parked 状态的 run。',
        '结束时检查不变量：没有未结束的 run，全部 completed，没有死信，每个 run 的事件日志恰好一个 run_finished 且之后没有写入，每个要工单的 run 恰好一张工单，每张工单的通知恰好生效一次，任何时刻租户在途数都不超过上限。任一条不满足，进程退出码为 1，可以放进 CI。',
        '下面是开着栅栏令牌的真实输出。“栅栏拒绝僵尸写入 14 次”就是冻结醒来的 worker 试图写入被拦下的次数；“投递 111、生效 100”说明有 11 次重复投递，全部被消费端去重。',
      ],
      files: ['examples/13-chaos.ts'],
      command: 'npm run chaos',
      output: `== 第二部分：混沌测试（栅栏令牌开启） ==

worker 进程 4 个（每个并发 3），租约 600ms，每租户在途上限 4，run 200 个（一半要提交工单）
混沌：kill -9 12 次，冻结 14 次（每次 1500ms）

耗时 12.1 s，吞吐 16.5 run/s
领取 337 次，其中接手别人过期租约 37 次；栅栏拒绝僵尸写入 14 次；人工确认 100 次
队列最大积压 200，单租户最大在途 4（上限 4）
outbox：已投递 100，待投递 0，死信 0；通知服务收到 111 次，生效 100 次

✔ 每个 run 都已结束（没有丢失或卡住的）  —  未结束 0
✔ 所有 run 都成功完成  —  completed 200
✔ 死信为 0  —  死信 0
✔ 每个 run 的事件日志恰好一个 run_finished，且之后没有写入  —  异常 0 个
✔ 每个要工单的 run 恰好一张工单  —  工单 100 张 / 应有 100，重复 0，缺失 0
✔ 每张工单的通知恰好生效一次  —  生效 100，投递 111（重复投递 11 次被去重）
✔ 租户在途数从未超过上限  —  最大 4

全部不变量成立`,
      outputNote: '混沌部分每次随机，kill 和冻结的次数、重复投递数、耗时每次不同，不变量应该每次都成立。领取次数比 run 多，是因为审批后重新入队会再领一次（200 + 100），其余是接手过期租约。吞吐受 mock 模型人为加的延迟和冻结限制，不代表真实性能。',
    },
    {
      title: '关掉栅栏再跑一次',
      text: [
        '`--no-fencing` 让队列不建触发器，只在续约和完成时检查 owner。下面是真实输出：10 个 run 最终是 cancelled——僵尸醒来后续约失败，用 LEASE_LOST 中止自己，把 run 状态写成 cancelled，覆盖了接手者已经写好的 completed；9 个 run 的事件日志在 run_finished 之后还有写入。用户看到的是“明明已经完成的工单申请变成了已取消”。',
        '这次没有出现重复工单，是因为第 5 章给 create_ticket 加的幂等键（run id + 工具调用 id）挡住了：僵尸和接手者多数时候执行的是事件日志里同一个工具调用，幂等键相同，第二次拿到的是已有的工单。这说明了两件事：幂等键是第一道防线，能用就用；但它只保护有幂等键的那一个副作用，而且前提是双方执行的是同一个调用——run 状态、事件日志、记忆这些写入没有保护，所以仍然需要栅栏。测试里那个更极端的场景（僵尸和接手者各自让模型生成了一次工具调用，调用 id 不同）会写出第二张工单。',
        '同一个场景跑多次，被破坏的不变量数量不同，有时可能侥幸全部通过——并发 bug 就是这样，只跑一次不能说明没有问题。这也是测试里用手动时钟构造确定性场景、混沌脚本只用来补充的原因。',
      ],
      command: 'npm run chaos -- --no-fencing',
      output: `== 第二部分：混沌测试（栅栏令牌关闭！） ==

worker 进程 4 个（每个并发 3），租约 600ms，每租户在途上限 4，run 200 个（一半要提交工单）
混沌：kill -9 15 次，冻结 15 次（每次 1500ms）

耗时 14.3 s，吞吐 14.0 run/s
领取 340 次，其中接手别人过期租约 42 次；僵尸的队列操作被 owner 检查拒绝（run 表本身不设防） 17 次；人工确认 98 次
队列最大积压 200，单租户最大在途 4（上限 4）
outbox：已投递 93，待投递 0，死信 0；通知服务收到 98 次，生效 93 次

✔ 每个 run 都已结束（没有丢失或卡住的）  —  未结束 0
✘ 所有 run 都成功完成  —  completed 190，cancelled 10
✔ 死信为 0  —  死信 0
✘ 每个 run 的事件日志恰好一个 run_finished，且之后没有写入  —  异常 9 个
✔ 每个要工单的 run 恰好一张工单  —  工单 93 张 / 应有 93，重复 0，缺失 0
✔ 每张工单的通知恰好生效一次  —  生效 93，投递 98（重复投递 5 次被去重）
✔ 租户在途数从未超过上限  —  最大 4

2 条不变量被破坏`,
      outputNote: '省略了第一部分。“应有 93”比 100 少，是因为有几个 run 在审批前被僵尸改成了 cancelled，不会再提交工单。退出码为 1。',
    },
    {
      title: '测试，以及三个只有多进程才会遇到的坑',
      text: [
        '8 个测试覆盖：多个进程同时抢任务时每个 run 只被领取一次；租约过期后被接手、令牌加 1、旧 worker 续约失败；栅栏拒绝僵尸写入（以及关掉栅栏时的重复工单）；同一进程不会重新领取自己仍在执行的 run；outbox 重复投递只生效一次、业务事务回滚时消息不存在；重试次数用完进死信；租户并发上限和排队上限；worker 端到端走完审批流程。',
        '第一个坑：SQLite 的锁不公平。第一版的“多进程抢任务”测试里，一个进程领走了全部任务，另外三个一个都没领到——测试通过了“不重复”，却没有测到并发。原因是 SQLite 的 busy handler 是“睡一会儿再试”，持有锁的进程释放后立刻又抢回去，等待的进程每次醒来锁都被占着。修复是每个子进程从同一时刻开始，每领一个任务让出 2ms 事件循环。真实的 worker 有模型调用作为天然间隔，不会这么极端，但这说明 SQLite 的写锁不是排队锁，高争用时有进程会饿死。',
        '第二个坑：mock 模型生成的工具调用 id 是进程内计数器（mock_1、mock_2…），run 被另一个进程接手后，新进程的计数器从头开始，生成的 id 和事件日志里已有的相同，重放时会把两次调用当成一次。`uniqueCallIds(model, prefix)` 给每个 worker 的调用 id 加上进程前缀。真实模型的 id 是全局唯一的，但任何“进程内计数器当全局 id”的代码在多进程下都会出这个问题。',
        '第三个坑是 `npm run verify` 在一次混沌测试里抓到的：开着栅栏，仍然有 1 个 run 在 run_finished 之后又被写入，重跑多数时候又通过。原因是栅栏上下文按数据库连接记录、以 run_id 为键，而一个 worker 进程里的多个任务共用一个连接。进程整体卡住、租约过期后，醒来的主循环先于旧任务运行，又把同一个 run 领了回来：新令牌覆盖了旧令牌，旧任务的僵尸写入因此通过检查；旧任务结束时 `forget()` 又删掉了新任务的上下文，之后的写入完全不受栅栏约束。修复是领取时排除本进程仍在执行的 run（`claim(owner, exclude)`），让别的进程接手。教训：栅栏令牌必须属于“持有租约的那次执行”，不能属于进程或连接；偶发失败的混沌测试不能靠重跑通过。',
      ],
      files: ['test/distributed.test.ts', 'test/fixtures/claim-worker.ts'],
      command: 'node --test test/distributed.test.ts',
      output: `✔ 多个进程同时抢任务：每个 run 只被领取一次 (3222.2415ms)
✔ 租约过期后被其他 worker 接手，令牌加 1，旧 worker 续约失败 (21.1212ms)
✔ 栅栏令牌：卡住后醒来的旧 worker 写不进任何东西；关掉栅栏就会写出重复工单 (45.6662ms)
✔ 同一进程不会重新领取自己仍在执行的 run：交给别的进程接手，旧任务的写入照样被栅栏挡住 (20.5524ms)
✔ outbox：重复投递时消费端只生效一次；业务事务回滚时消息也不存在 (2.8754ms)
✔ 重试次数用完进入死信，run 标记为失败而不是永远“执行中” (20.7054ms)
✔ 租户并发上限与排队上限：大租户占不满所有 worker，排队太多时拒绝入队 (2.894ms)
✔ worker 端到端：执行到审批时挂起，批准后重新入队并完成，工单通知只生效一次 (53.7329ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0`,
      outputNote: '省略了 suites、skipped 等为 0 的统计行。第一个测试最慢，因为它要启动 4 个子进程并等它们同时开始。',
    },
    {
      title: '用队列模式运行服务',
      text: [
        '开一个终端启动 API，再开几个终端各启动一个 worker，它们共享 data/agent.db。在页面上提问、提交工单、审批，行为和单进程模式一样；关掉任何一个 worker（Ctrl+C 是优雅退出，正在执行的 run 放回队列；直接关窗口相当于 kill -9，等租约过期由别人接手）都不影响结果。',
        '队列模式下 API 进程不再执行 run，也不再在启动时 recover（恢复由租约过期自然完成）。审批由 API 调用 `resumeAfter()`：在同一个事务里记录决定并重新入队。SSE 流改为每 300ms 轮询事件表，因为执行在另一个进程里，进程内的事件通知收不到；同样的原因，回答不再逐 token 流式显示，而是一段一段出现。',
        '设置了 `WEBHOOK_URL` 时，投递器把工单通知 POST 过去（带 Idempotency-Key 头）；没设置时投递到本地的 `<数据库>-inbox.db`，可以打开看收到了什么。其他参数：`QUEUE_LEASE_MS`（默认 30000）、`QUEUE_MAX_ATTEMPTS`（默认 5）、`TENANT_MAX_INFLIGHT`（默认 4）、`TENANT_MAX_QUEUED`（默认 100）、`WORKER_CONCURRENCY`（默认 4）。',
      ],
      files: ['src/worker.ts', '.env.example'],
      command: `# macOS / Linux
RUN_MODE=queue npm run server
RUN_MODE=queue npm run worker      # 另开终端，可以开多个

# Windows PowerShell
$env:RUN_MODE='queue'; npm run server
$env:RUN_MODE='queue'; npm run worker`,
    },
    {
      title: 'SQLite 的边界，以及往哪里迁移',
      text: [
        'SQLite 在这里是够用的，但边界很清楚：① 同一时刻只有一个写者，所有 worker 的领取、续约、事件写入都在抢同一把锁，写入量大时吞吐的上限就是一个磁盘文件的写入速度；② 只能在一台机器上：多个进程共享文件靠的是操作系统的文件锁，SQLite 官方明确不建议把数据库放在 NFS、SMB 之类的网络文件系统上，锁可能失效，数据会损坏；③ 没有服务端推送，等待者只能轮询。所以本章的方案适合“一台机器、多个进程”，例如把 worker 和 API 分开、利用多核、单个 worker 崩溃不影响其他。',
        'Postgres：领取用 `SELECT … FROM run_queue WHERE … ORDER BY … LIMIT 1 FOR UPDATE SKIP LOCKED`，再在同一事务里 UPDATE。SKIP LOCKED 让多个 worker 跳过别人正在领的行，不会互相阻塞，这是 Postgres 做队列的标准写法（pg-boss、graphile-worker、Oban 都是这样）。`pg_advisory_lock` 适合“同一时刻只有一个实例跑投递器或定时任务”之类的全局互斥。`LISTEN/NOTIFY` 可以在入队时唤醒 worker，代替轮询。栅栏令牌照搬：令牌列加 `WHERE fence = $1` 条件，或者用触发器比对会话变量（`SET LOCAL app.fence = …`）。',
        'Redis Streams：`XADD` 入队，消费者组 `XREADGROUP` 领取，`XACK` 确认，长时间没确认的消息用 `XAUTOCLAIM` 转给别的消费者——这就是租约和接手。但 Redis 本身不是业务数据库，工单写在 Postgres、消息在 Redis，又回到了双写问题，仍然需要 outbox（先写 Postgres 的 outbox 表，再由投递器搬到 Redis）。Redis 的锁也没有栅栏令牌，对正确性有要求的写入还是要在业务库里检查。',
        '持久化工作流引擎（Temporal、Restate、Inngest、DBOS）把本章的大部分工作接过去：持久化每一步的结果，崩溃后从上次完成的步骤继续（相当于第 4 章的重放加本章的租约和接手）；内置重试、超时、心跳；“等待人工审批”可以是一个持续几天的 await；活动（activity / step）的结果被记录下来，不会重复执行已经成功的步骤。DBOS 直接把状态存在你的 Postgres 里；Temporal 需要单独部署服务。它们给不了的是业务层面的幂等：一个活动执行到一半崩溃，会被再执行一次，调外部 API 时仍然需要幂等键。选择时看团队能不能运维额外的服务、工作流是否足够长和复杂到值得引入。',
        '时钟偏差：本章的租约到期时间是写入者用自己的时钟算的，各个进程在同一台机器上共享时钟，问题不大。跨机器时，一台机器的时钟快 10 秒，它会提前认为别人的租约过期并接手。缓解办法：用数据库的时钟（Postgres 的 `now()`）而不是客户端时钟；租约时长远大于可能的偏差；最重要的是——正确性不依赖时钟，靠的是栅栏令牌。时钟偏差最多导致不必要的接手（浪费），不会导致错误的写入。',
      ],
    },
  ],
  pitfalls: [
    { symptom: '偶尔出现两张一样的工单，或者已经完成的 run 状态突然变成失败 / 已取消', cause: '只有租约没有栅栏：旧 worker 停顿（GC、断网、虚拟机迁移）后醒来，不知道租约已经被别人拿走，继续写入。', fix: '每次领取递增令牌，所有写入在存储端和当前令牌比对；用手动时钟构造“停顿→接手→醒来”的确定性测试。' },
    { symptom: '下游偶尔收不到工单通知，或者同一张工单通知两次', cause: '在业务代码里先写库再调 API（或者反过来），进程在两步之间崩溃。', fix: '事务性 outbox：消息和业务数据同一事务写入，投递器至少一次投递，消费端按消息 id 去重，去重和效果在同一事务里。' },
    { symptom: '某个 run 每次都让 worker 崩溃，队列一直在重试它，其他任务越来越慢', cause: '毒消息没有重试上限，或者只在 fail() 里计数——进程直接崩溃时根本走不到 fail()。', fix: '在领取时计数（attempt + 1），领取前先把“租约过期且次数用完”的移进死信；死信数量要有告警。' },
    { symptom: '健康的 worker 经常丢租约，同一个 run 被反复接手', cause: '续约间隔接近租约时长，或者续约和执行共用一个被长时间同步计算阻塞的事件循环。', fix: '续约间隔取租约的 1/3 或更短；租约时长远大于正常的停顿；监控“接手别人过期租约”的次数。' },
    { symptom: '开着栅栏，混沌测试仍偶发“run_finished 之后还有写入”，重跑又通过', cause: '栅栏上下文按连接记录，同一进程的多个任务共用连接；进程卡住后又领回自己的 run，新令牌覆盖旧令牌，旧任务结束时还删掉了新任务的上下文。', fix: '令牌属于一次执行而不是一个进程：领取时排除本进程仍在执行的 run，或者把令牌作为参数随每次写入传下去。偶发失败要定位到根因，不能靠重跑。' },
    { symptom: '多进程共享 SQLite 时偶发 database is locked，或者某个进程长时间领不到任务', cause: '没有设置 busy_timeout，写锁冲突时立即报错；或者高争用下 SQLite 的锁不公平，持有者释放后马上又抢回去。', fix: '设置 busy_timeout，写事务尽量短；领取之间让出事件循环；写入量真的大时迁移到 Postgres。' },
    { symptom: '把 SQLite 文件放到共享网盘上让多台机器的 worker 一起用，数据库损坏', cause: '网络文件系统上的文件锁不可靠，SQLite 官方明确不支持这种用法。', fix: '多台机器就换成 Postgres（FOR UPDATE SKIP LOCKED）或者持久化工作流引擎。' },
  ],
  exercises: [
    { id: 't-dist-postgres', text: '把 RunQueue 移植到 Postgres：领取用 FOR UPDATE SKIP LOCKED，入队时用 NOTIFY 唤醒 worker，栅栏用触发器比对 SET LOCAL 设置的会话变量。复用本章的测试，确认全部通过', detail: '用 docker 启动 Postgres；注意 SKIP LOCKED 必须在事务里和随后的 UPDATE 一起执行，否则锁会在 SELECT 结束后释放。' },
    { id: 't-dist-priority', text: '给队列加优先级：交互式提问优先于批量任务，但低优先级不能饿死（例如排队超过 60 秒的自动提升一级）。写测试证明两点都成立' },
    { id: 't-dist-cancel', text: '现在取消一个正在执行的 run，靠的是令牌加 1 让执行者下一次写入失败。改成主动通知：worker 续约时发现令牌变了就立即中止，并测量从点击取消到 worker 停止的延迟' },
    { id: 't-dist-chaos-ci', text: '把 npm run chaos 加进 CI，跑 5 次不同种子；再加一种故障：随机让投递器在 ack 之前崩溃，确认重复投递次数上升但生效次数不变' },
    { id: 't-dist-temporal', text: '用 Temporal、Restate、Inngest 或 DBOS 中的一个重写“提问 → 等审批 → 建工单 → 通知”流程，对比代码量、需要部署的组件，以及它们如何处理本章的僵尸 worker 和双写问题' },
  ],
  deeper: { stageId: 'advanced', text: '深入专题：进阶架构' },
  interview: [
    { q: '分布式锁加了过期时间，为什么还会有两个持有者同时写？怎么解决？', a: [
      '过期时间只保证持有者死掉后锁能被释放，但持有者可能只是停顿了（GC、断网、虚拟机暂停），醒来后不知道锁已经过期，继续写入。“写之前检查锁”也不行，检查和写之间仍然可能停顿。',
      '解决办法是栅栏令牌：每次加锁返回一个递增的号码，所有写入带上它，存储端拒绝比当前小的号码。判断在存储端、和写入同一个原子操作里完成，不依赖持有者的判断，也不依赖时钟。',
    ] },
    { q: '怎么保证“改数据库”和“发消息/调外部 API”的一致性？', a: [
      '不能在业务代码里先后做两件事，崩溃在中间就会丢或重复；分布式事务（2PC）成本高，外部 HTTP API 也不支持。',
      '用事务性 outbox：业务数据和待发消息在同一个本地事务里写入，后台投递器读 outbox 投递，成功后标记完成。投递是至少一次的，消费端按消息 id 去重，去重记录和效果在同一个事务里。也可以用 CDC（如 Debezium 读数据库日志）代替轮询 outbox 表。',
    ] },
    { q: '你们的系统能保证恰好一次（exactly-once）吗？', a: [
      '投递层面不能：发送方收不到确认时无法区分对方没收到还是确认丢了，只能重发。说“恰好一次”的系统（Kafka 事务、Flink）指的是在它自己的边界内，通过幂等写入和事务把重复去掉，效果上恰好一次。',
      '我们的做法是至少一次投递 + 每一层幂等：create_ticket 有幂等键，outbox 消息 id 由工单 id 派生，消费端按消息 id 去重，run 状态写入有栅栏令牌。再用混沌测试验证不变量：没有丢失的 run，没有重复的工单和通知。',
    ] },
    { q: 'Agent 的任务调度和普通后台任务有什么不同？', a: [
      '运行时间长（几十秒到几分钟），中间可能挂起几天等人工审批，所以等待审批时要释放 worker（parked 状态），批准后重新入队；租约要配合心跳，不能设一个很长的固定超时。',
      '副作用多且外部化（建工单、发通知、改数据），重试时必须幂等，重放时要能跳过已经执行过的工具调用；成本按 token 计算，要按租户限制并发，防止一个租户耗尽模型配额和 worker。',
      '规模变大后可以考虑持久化工作流引擎，它们把“每一步的结果持久化、崩溃后从断点继续、长时间等待”做成了基础设施。',
    ] },
  ],
};
