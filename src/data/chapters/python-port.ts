import type { Chapter } from '../tutorial';

export const chapter: Chapter = {
  id: 'python-port',
  part: 'advanced',
  title: '第 27 章 Python 版本：用标准库移植参考项目的核心',
  summary: '很多团队的 Agent 服务用 Python 写。本章把参考项目的核心——模型适配、SSE 解析、工具调用循环、先过滤权限的检索、需审批的建单、SQLite 事件日志、离线 mock 模型和评测门禁——用 Python 3.11+ 标准库移植一遍，逐项对比两种语言在异步、取消、类型校验、打包和部署上的差别，再把每一部分对应到 pydantic、FastAPI、OpenAI Python SDK、Pydantic AI 和 LangGraph。',
  minutes: 180,
  outcome: '`course/ticket-agent/python` 里有一个零第三方依赖的 Python 版 Agent：21 个 unittest 测试全部通过；同样的 8 条评测用例 100% 通过，token 总量 6509 与 TS 版完全一致；你能说清 asyncio 的取消和 AbortSignal 有什么不同、为什么吞掉 CancelledError 是严重错误、阻塞 IO 会怎样拖垮事件循环，以及什么时候该引入框架。',
  concepts: [
    { term: '协作式事件循环', text: 'Node 和 asyncio 都是单线程事件循环：只有在 await 处才会切换到别的任务。区别在于 Node 的网络、定时器 API 天生是非阻塞的，而 Python 标准库大部分 IO（urllib、http.client、input、time.sleep）是阻塞的。在协程里直接调用它们，整个进程的所有请求都会停住。' },
    { term: 'asyncio 的取消', text: 'TS 版把 AbortSignal 一层层传下去，每层自己检查。asyncio 由 `task.cancel()` 在下一个 await 点抛出 `CancelledError`，不需要传参数；但它只能打断 await，不能打断正在线程里阻塞的 IO 或一段不 await 的 CPU 循环。`CancelledError` 继承 `BaseException`，`except Exception` 不会误吞它，捕获后必须继续抛出。' },
    { term: '类型注解不是校验', text: 'TS 的类型在编译期检查，Python 的类型注解在运行时完全不检查。两者都不能防住模型生成的错误参数，所以工具参数必须在运行时校验。生产项目常用 pydantic：同一个模型类既生成 JSON Schema，又做校验，二者不会不一致。' },
    { term: 'GIL', text: '全局解释器锁让同一进程内同一时刻只有一个线程执行 Python 字节码，但线程在等待网络 IO 时会释放它。Agent 服务的大部分时间在等模型和数据库，是 IO 密集型，GIL 不是瓶颈；本地算 embedding、大量 JSON 处理这类 CPU 密集的部分才需要多进程或单独的服务。' },
    { term: '行为对齐（parity）', text: '同一份业务逻辑有两种语言的实现时，最大的风险是悄悄漂移。本章用三种手段对齐：数据和评测用例逐字段比对、同一评测集必须全部通过、mock 模型下 token 总量必须一致（它取决于每条消息的字符数，序列化方式稍有不同就会变）。' },
  ],
  steps: [
    {
      title: '移植范围和目录：先跑通评测门禁',
      text: [
        '目标不是做一个“Python 版全部功能”，而是把决定 Agent 正确性的核心移植过来，并证明行为一致。移植了：模型适配器（流式、重试、超时、取消）、SSE 解析、工具调用循环（只读并发、步数和 token 预算）、先过滤权限的知识检索、草稿 + 审批 + 幂等建单、SQLite 事件日志与崩溃恢复、离线 mock 模型、评测门禁、命令行入口。',
        '没有移植：HTTP 服务和前端（第 6–7 章，最后一步给出 FastAPI 的对应写法）、上下文裁剪（第 13 章）、模型降级链（第 15 章）、混合检索（第 18 章）、MCP 服务（第 12 章）。它们都可以按同样的方法补上，见练习。',
        '目录：`ticket_agent/` 下每个模块对应 TS 版的一个文件，文件开头注明对应关系；`tests/` 是 unittest 测试；`pyproject.toml` 声明 Python 3.11+、没有任何依赖。需要 3.11 是因为用到了 `asyncio.timeout` 和 `datetime.fromisoformat` 对 `Z` 结尾时间的解析。',
        '在 `course/ticket-agent/python` 目录下运行评测。和 TS 版一样，mock 模型每 4 个字停 15ms 模拟打字机效果，所以延迟和 TS 版在同一量级。token 总量 6509 与 `npm run eval` 的结果完全一致：mock 模型按每条消息的字符数估算 token，只要系统提示词、工具结果的 JSON 序列化或检索片段有一个字符不同，这个数字就会变，所以它是一个很灵敏的一致性检查。',
      ],
      files: ['python/pyproject.toml', 'python/ticket_agent/__main__.py'],
      command: 'cd python\npython -m ticket_agent eval',
      output: `评测模型：mock（离线模拟），检索：keyword，共 8 条用例

PASS  travel-current-version  418ms
PASS  [critical] tenant-isolation  284ms
PASS  [critical] role-acl-denied  166ms
PASS  role-acl-allowed  267ms
PASS  no-evidence-refusal  198ms
PASS  [critical] ticket-approved  483ms
PASS  [critical] ticket-rejected  435ms
PASS  [critical] prompt-injection  512ms

通过率：100%（门槛 90%）
critical 失败：无
token 总量：6509　估算成本：0.0000 元（按 .env 中的单价）
延迟：p50 284ms　p95 512ms
结论：✅ 可以发布`,
      outputNote: '延迟数字每次运行都不同。macOS / Linux 上如果 python 指向 Python 2 或不存在，用 python3。',
    },
    {
      title: '两种语言的关键差别一览',
      text: [
        '下面这张表是本章的主线，后面每一步展开其中一行。总的结论：Agent 的结构（事件日志、状态机、工具循环、审批、评测）与语言无关，可以逐行移植；真正需要重新思考的是异步 IO 和取消，因为两种运行时在这里的默认行为不同。',
      ],
      code: {
        title: 'TypeScript 版 vs Python 版',
        content: `方面        TypeScript（src/）                          Python（python/ticket_agent/）
运行时      Node 24+，直接运行 .ts                        CPython 3.11+，只用标准库
异步 IO     fetch 天生非阻塞                              标准库没有异步 HTTP：http.client 放进 asyncio.to_thread
取消        AbortSignal 显式逐层传递，fetch 原生支持       task.cancel() 在 await 点抛 CancelledError；线程里的阻塞 IO 要自己关 socket
总超时      AbortSignal.timeout + AbortSignal.any         async with asyncio.timeout(...)
只读并发    Promise.allSettled                            asyncio.gather(..., return_exceptions=True)
类型/校验   tsc 编译期检查 + 运行时手写校验                注解不做运行时检查；dataclass + 手写校验（生产常用 pydantic）
JSON        JSON.stringify 不转义中文、无空格              json.dumps 默认转义中文、带空格，要显式设置
SQLite      node:sqlite，同步                             sqlite3，同步，连接默认只能在创建它的线程里用
测试        node:test                                     unittest（IsolatedAsyncioTestCase 跑协程）
打包        package.json，零运行时依赖                     pyproject.toml，dependencies = []
部署        单个 node 进程 + Docker                       uvicorn/gunicorn 多个 worker 进程 + Docker`,
      },
    },
    {
      title: '类型与工具参数校验：dataclass 加手写校验',
      text: [
        'TS 的消息类型是联合类型，Python 版用 `@dataclass(frozen=True)`。dataclass 只是带字段的类，不做任何运行时检查——这和 TS 类型一样，只是“文档”。真正的防线是工具的 `parse`：模型生成的参数是不可信输入，必须逐字段校验，错误以 `INVALID_ARGUMENTS` 回传给模型，让它自己改正。`require_string`、`optional_string_array` 与 TS 版的校验函数一一对应，错误文字也相同。',
        '`dumps` 是一个容易被忽视的细节：`json.dumps` 默认 `ensure_ascii=True`，会把中文写成 `\\uXXXX`，还会在逗号和冒号后面加空格。后果有两个：一是字符数变多，按字符估算的 token 和预算都偏大；二是更危险的——评测里“工具结果中不能出现某段中文”的检查会永远通过，因为序列化后的文本里根本没有这段中文。`test_detects_leaked_chinese_text_in_tool_results` 专门锁住这一点：把序列化换回默认参数，这个测试就会失败。',
        '生产项目里通常用 pydantic 定义参数模型，下面是 `prepare_ticket` 的对应写法（示意，本仓库不依赖 pydantic）。好处是 schema 和校验来自同一个类；要注意 pydantic 默认会做类型转换（例如把数字 1 转成字符串需要显式关闭严格模式才会报错），对模型参数建议开启 `strict` 或至少禁止多余字段。',
      ],
      files: ['python/ticket_agent/types.py', 'python/ticket_agent/tools.py'],
      code: {
        title: '用 pydantic 定义工具参数（示意）',
        content: `from pydantic import BaseModel, ConfigDict, Field, ValidationError

class PrepareTicketArgs(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=80, description='一句话标题，例如“VPN 无法连接”')
    description: str = Field(min_length=1, max_length=2000)
    sourceIds: list[str] = Field(default_factory=list, max_length=5)

spec = {'name': 'prepare_ticket', 'description': '…', 'parameters': PrepareTicketArgs.model_json_schema()}

try:
    args = PrepareTicketArgs.model_validate_json(call.arguments)
except ValidationError as error:
    ...  # 转成 INVALID_ARGUMENTS 回传给模型，不要把整段 Python 异常原样塞回去`,
      },
    },
    {
      title: 'SSE 解析：增量解码器 + 缓冲到空行',
      text: [
        '`SSEParser` 与 TS 版的 `readSSE` 逻辑相同：累积缓冲，遇到空行才交出一个完整事件，多行 `data:` 用换行拼接，流结束时把最后一个没有空行结尾的事件也交出来。它被写成一个与 IO 无关的类（`feed` / `close`），同步和异步代码都能用，测试也不需要网络。',
        'Python 的坑在解码：每收到一块就 `chunk.decode()`，只要一个汉字（UTF-8 下 3 个字节）被切在两块之间，就会抛 `UnicodeDecodeError`。TS 用 `TextDecoder` 的 `stream: true`，Python 对应的是 `codecs.getincrementaldecoder("utf-8")()`，它会把不完整的字节留到下一块。`\\r\\n` 的替换放在累积后的缓冲区上做，`\\r` 和 `\\n` 被切在两块里时也能正确处理。',
        '测试把一段包含中文、注释行和 `\\r\\n` 的流按每块 1 字节喂进去，结果必须和一次性喂入完全相同。',
      ],
      files: ['python/ticket_agent/sse.py', 'python/tests/test_sse.py'],
    },
    {
      title: '模型适配器：线程里做阻塞 IO，事件循环负责等待和取消',
      text: [
        '标准库没有异步 HTTP 客户端。`OpenAICompatibleModel` 用 `http.client` 发请求，每一次阻塞调用（发送请求、读一块响应）都放进 `asyncio.to_thread`，事件循环在等待期间可以处理别的 run。读响应用 `read1` 而不是 `read(n)`：`read(n)` 会等凑满 n 字节才返回，打字机效果就变成了“攒一批再吐一批”。',
        '重试规则与 TS 版相同：429 和 5xx 可以重试，遵守 `Retry-After`；还没向用户输出文字时，连接中断可以重试；已经输出了就不能重试，否则内容会重复。没有收到 `finish_reason` 也没有 `[DONE]` 的流一律视为中断，因为工具参数可能只收到一半。',
        '取消和超时是和 TS 差别最大的地方。`async with asyncio.timeout(...)` 给整个请求设总超时，到时抛 `TimeoutError`（可以重试）；用户取消抛 `CancelledError`（继承 `BaseException`，不在可重试的异常列表里，永远不重试）。但 `to_thread` 里的线程不会因为协程被取消而停下，它仍然卡在 `recv` 上，直到 socket 超时。所以 `finally` 里主动 `shutdown` socket：线程立刻返回，不会留下占着连接的僵尸线程。测试用一个只发响应头、不发内容的本地服务验证：取消在 1 秒内生效，超时抛 `TimeoutError`。',
        '换成官方 OpenAI Python SDK 时，`AsyncOpenAI` 自带异步 HTTP、重试（`max_retries`）和超时（`timeout`），流式响应是一个 `async for` 迭代器，每个 chunk 的结构与本章 `read_stream` 处理的 JSON 相同：拼接 `delta.content`、按 `index` 拼接 `tool_calls`、在最后一个 chunk 里取 `usage`。SDK 替你处理的是传输层，“已经输出了文字就不能重试”这类业务规则仍然要自己写。',
      ],
      files: ['python/ticket_agent/openai_compat.py', 'python/tests/test_openai.py'],
      code: {
        title: '同样的流式调用，用 OpenAI Python SDK（示意）',
        content: `from openai import AsyncOpenAI

client = AsyncOpenAI(base_url=base_url, api_key=api_key, max_retries=2, timeout=60)
stream = await client.chat.completions.create(
    model=model, messages=messages, tools=tools, max_tokens=max_output_tokens,
    stream=True, stream_options={'include_usage': True},
)
async for chunk in stream:
    if chunk.usage:
        usage = chunk.usage
    if not chunk.choices:
        continue
    delta = chunk.choices[0].delta
    ...  # 与 read_stream 相同：拼 content 并回调 on_text，按 index 拼 tool_calls`,
      },
    },
    {
      title: 'Agent 循环与取消：CancelledError 必须继续抛出',
      text: [
        '`run_agent` 与 TS 版的 `runAgent` 逐段对应：先执行上一轮没有结果的工具调用（相邻只读调用用 `asyncio.gather` 并发，写操作是顺序屏障），再检查步数和 token 预算，再调用模型；模型回复、用量和结束状态在同一个事务里写入。事件 data 的字段名保持 camelCase，SQLite 表结构也与 TS 版相同。',
        '取消的写法不同。TS 版检查 `signal.aborted` 后返回 `cancelled`。Python 版捕获 `CancelledError`，写入 `run_finished(cancelled)` 后必须 `raise`。如果吞掉它返回一个状态，`asyncio.timeout` 会以为任务没被取消、超时失效，`TaskGroup` 也无法正确收尾。服务重启用 `task.cancel(SHUTDOWN)` 表示：不写结束事件，run 保持 `running`，重启后从事件日志接着跑。',
        '工具执行的 `except Exception` 不会误捕获取消，这是 Python 3.8 起把 `CancelledError` 改为继承 `BaseException` 的原因。反过来，在任何地方写 `except BaseException:` 或裸 `except:` 而不重新抛出，都会破坏取消。',
      ],
      files: ['python/ticket_agent/agent.py', 'python/tests/test_agent.py'],
    },
    {
      title: '权限过滤、审批建单与 SQLite 持久化',
      text: [
        '检索仍然是“先过滤、再打分”：`visible_documents` 按租户、版本状态和角色过滤，是唯一的权限规则。移植时要注意两个细节：Python 的 `re` 不支持 `\\p{P}`、`\\p{S}`，用 `unicodedata.category` 判断标点和符号；JS 的 `Set` 保持插入顺序，Python 的 `set` 不保证，所以二元组用 `dict.fromkeys` 当有序集合，否则片段的截取位置可能和 TS 版不同。',
        '`create_ticket` 的 `requires_approval=True`：第一次执行只写 `approval_requested` 并暂停；只有 run 的发起人能审批，过期按拒绝处理；工单用 “run + 工具调用” 作幂等键，崩溃后重复执行也只会产生一张。测试覆盖：暂停时再跑一次也不会越过审批、别人不能替你审批、审批后只创建一张、过期的审批不会创建。',
        '`Store` 用标准库 `sqlite3`，`isolation_level=None` 关闭模块自带的隐式事务，由 `transaction()` 显式 `BEGIN IMMEDIATE`，与 `node:sqlite` 的行为一致。sqlite3 连接默认只能在创建它的线程里使用：本项目所有数据库操作都在事件循环线程里同步执行（本地 SQLite 的单次写入是微秒级），不把它放进 `to_thread`。崩溃恢复测试把事件写进磁盘文件、关闭、重新打开，验证 run 从断点继续且工具只执行一次。',
      ],
      files: ['python/ticket_agent/store.py', 'python/ticket_agent/seed.py', 'python/tests/test_tools.py'],
    },
    {
      title: '离线 mock 模型、评测门禁和跨语言一致性',
      text: [
        '`MockModel` 与 TS 版的关键词规则相同：先检索、需要工单时拟草稿、再提交、最后带引用作答。`ScriptedModel` 按顺序返回预先写好的回复，用来在测试里精确构造“模型调用了不存在的工具”“参数不合法”“一直在循环”等情况。',
        '评测门禁也逐行移植：critical 用例必须全过，且总通过率不低于 90%。一个小坑：引用的正则 `\\[([\\w-]+@v\\d+)\\]` 在 Python 里 `\\w` 默认匹配中文，要加 `re.ASCII` 才与 JS 一致。',
        '种子数据和评测用例在两种语言里各有一份（数据很小，直接移植比引入共享文件格式更简单）。`test_parity.py` 在装了 Node 时用 `node -e` 直接导入 TS 源码，逐字段比对；没有 Node 时跳过。这样任何一边改了数据或用例而另一边没改，测试都会失败。',
      ],
      files: ['python/ticket_agent/mock.py', 'python/ticket_agent/evaluate.py', 'python/tests/test_eval.py', 'python/tests/test_parity.py'],
    },
    {
      title: '运行全部测试',
      text: [
        '根目录的 `npm run test:python` 运行全部 Python 测试。它没有加进根目录的 `npm test`：Python 是可选的，没有安装 Python 的读者不应该因此跑不通前面的章节。CI 里可以单独加一步。',
        'unittest 的 `IsolatedAsyncioTestCase` 为每个测试创建新的事件循环，可以直接写 `async def test_...`。适配器测试启动一个 `http.server` 本地服务，按每 5 字节一块发送 SSE，覆盖 429 重试、工具参数分块拼接、输出前 / 输出后断流、取消和超时，全程不访问外网。',
      ],
      command: 'cd python\npython -m unittest discover -s tests -t . -v',
      output: `test_adjacent_read_only_calls_run_concurrently (tests.test_agent.AgentLoopTest...) ... ok
test_max_steps_stops_a_looping_model (tests.test_agent.AgentLoopTest...) ... ok
test_tool_loop_feeds_results_back_and_rejects_bad_arguments (tests.test_agent.AgentLoopTest...) ... ok
test_rejected_or_expired_approval_creates_nothing (tests.test_agent.ApprovalTest...) ... ok
test_ticket_is_created_only_after_approval_and_only_once (tests.test_agent.ApprovalTest...) ... ok
test_resumes_from_sqlite_file_after_crash_without_repeating_tool_calls (tests.test_agent.CancellationAndPersistenceTest...) ... ok
test_user_cancel_finishes_run_and_shutdown_keeps_it_running (tests.test_agent.CancellationAndPersistenceTest...) ... ok
test_a_single_critical_failure_blocks_release_regardless_of_pass_rate (tests.test_eval.EvalGateTest...) ... ok
test_all_cases_pass_with_the_offline_model (tests.test_eval.EvalGateTest...) ... ok
test_detects_leaked_chinese_text_in_tool_results (tests.test_eval.EvalGateTest...) ... ok
test_cancel_and_timeout_interrupt_a_hanging_stream (tests.test_openai.OpenAICompatibleTest...) ... ok
test_interrupted_stream_retries_only_before_text_was_emitted (tests.test_openai.OpenAICompatibleTest...) ... ok
test_retries_429_and_assembles_tool_call_from_split_chunks (tests.test_openai.OpenAICompatibleTest...) ... ok
test_seed_and_eval_cases_match_the_typescript_source (tests.test_parity.ParityWithTypeScriptTest...) ... ok
test_async_generator_over_chunks (tests.test_sse.ReadSSETest...) ... ok
test_joins_multiline_data_and_flushes_last_event_without_blank_line (tests.test_sse.SSEParserTest...) ... ok
test_reassembles_events_split_inside_multibyte_chars_and_crlf (tests.test_sse.SSEParserTest...) ... ok
test_filters_by_tenant_status_and_role_before_scoring (tests.test_tools.PermissionFilterTest...) ... ok
test_same_question_returns_only_the_users_own_documents (tests.test_tools.PermissionFilterTest...) ... ok
test_snippet_is_cut_around_the_first_hit_in_long_documents (tests.test_tools.PermissionFilterTest...) ... ok
test_rejects_invalid_arguments_with_tool_errors (tests.test_tools.ToolArgumentTest...) ... ok

----------------------------------------------------------------------
Ran 21 tests in 2.188s

OK`,
      outputNote: '括号里的完整测试路径较长，这里截短为“...”。',
    },
    {
      title: '命令行对话：审批在终端里完成',
      text: [
        '`chat` 子命令和 `npm run chat` 一样：打印工具调用，遇到 `create_ticket` 时暂停并请你确认。`input()` 是阻塞调用，直接在协程里用会卡住事件循环，所以放进 `asyncio.to_thread`。',
        '入口还做了一件 Windows 上必需的事：输入输出被重定向到文件或管道时，Python 用系统区域编码（例如 cp1252）而不是 UTF-8，打印中文会抛 `UnicodeEncodeError`。所以 `main` 里把 stdin/stdout/stderr 重新配置为 UTF-8。下面的输出是把三行输入（问题、y、exit）通过管道送进去得到的。',
      ],
      command: 'cd python\npython -m ticket_agent chat --user alice',
      output: `模型：mock　用户：Alice（Acme 员工）　输入 exit 退出

你> Agent> 
  → 调用工具 search_knowledge {"query":"VPN 连不上，帮我提交 IT 工单"}
  ← 成功

  → 调用工具 prepare_ticket {"title":"VPN 连不上，帮我提交 IT 工单","description":"员工请求：VPN 连不上，帮我提交 IT 工单","sourceIds":["acme-vpn@v1"]}
  ← 成功


需要你确认：
提交工单「VPN 连不上，帮我提交 IT 工单」
员工请求：VPN 连不上，帮我提交 IT 工单
确认执行？(y/N) Agent> 
  → 调用工具 create_ticket {"draftId":"draft_9690f6ef"}
  ← 成功
根据《VPN 故障处理指南》[acme-vpn@v1]：VPN 无法连接：先重启客户端并确认账号未锁定。仍无法连接请提交 IT 工单，注明错误码和发生时间。
工单已创建，编号 TCK-MWKDCRHB-44b5。
[completed] 模型调用 4 次，token 1390+93`,
      outputNote: '草稿编号和工单编号每次运行都不同。接真实模型时在 course/ticket-agent/.env 里设置 MODEL_PROVIDER=openai 等变量，Python 版会读取同一个 .env 文件。',
    },
    {
      title: '映射到 Python 生态：什么时候引入框架',
      text: [
        'HTTP 服务：FastAPI 是最常见的选择。SSE 可以用 `StreamingResponse(media_type="text/event-stream")` 或 sse-starlette 的 `EventSourceResponse`。第 6 章的要求一条都不能少：按 `Last-Event-ID` 续传、客户端断开只停止推送而不取消 run、优雅退出时用 SHUTDOWN 取消。注意 FastAPI 里用 `def` 而不是 `async def` 定义的接口会在线程池里执行，这时就会碰到 sqlite3 的线程限制。',
        '数据库：本地 SQLite 的同步调用可以留在事件循环线程；换成 PostgreSQL 后必须用异步驱动（asyncpg、psycopg 3 的异步接口）或放进线程池，否则一次慢查询就会让所有 run 停住。',
        'Agent 框架：Pydantic AI 用类型注解和 pydantic 定义工具与输出，适合“类型驱动”的团队；LangGraph（Python）把循环建模成状态图，自带 checkpointer（SQLite、PostgreSQL）做持久化和恢复，用 `interrupt` 实现人工审批，概念上对应本项目的事件日志和 `waiting_approval`。引入之前先确认几件事：权限过滤是否仍在服务端、审批状态和幂等键是否落库、评测门禁能否照常运行。具体 API 以各项目当前文档为准，它们变化很快。',
        '打包和部署：`pyproject.toml` 声明依赖，锁文件用 uv 或 pip-tools 生成；容器镜像用 slim 基础镜像。asyncio 服务是单线程的，要用多核就开多个 worker 进程（uvicorn `--workers` 或 gunicorn + uvicorn worker），这时进程内的状态（例如正在运行的 run 列表、SSE 订阅者）不再共享，需要第 17 章说的队列和外部存储。',
      ],
      code: {
        title: 'FastAPI 中的 SSE 推送（示意，未在本仓库运行）',
        content: `from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

app = FastAPI()

@app.get('/api/runs/{run_id}/events')
async def run_events(run_id: str, request: Request):
    after = int(request.headers.get('last-event-id', 0))
    async def stream():
        async for event in subscribe(run_id, after):   # 先补发 after 之后的历史，再推新事件
            if await request.is_disconnected():
                break                                    # 只停止推送，不取消 run
            yield f'id: {event.seq}\\nevent: {event.type}\\ndata: {dumps(event.data)}\\n\\n'
    return StreamingResponse(stream(), media_type='text/event-stream',
                             headers={'cache-control': 'no-cache', 'x-accel-buffering': 'no'})`,
      },
    },
  ],
  pitfalls: [
    { symptom: '一个员工的请求在等模型时，其他所有员工的打字机效果都停住了', cause: '在协程里调用了阻塞 IO：requests/urllib、time.sleep、input、同步数据库驱动访问远程库。事件循环只有一个线程，它被占住，所有任务都停。', fix: '用异步库，或把阻塞调用放进 asyncio.to_thread；开发时设置 PYTHONASYNCIODEBUG=1 打开调试模式，耗时超过 100ms 的回调会打印警告。' },
    { symptom: '取消后 run 状态仍是 running，或者 asyncio.timeout 不起作用、任务一直不结束', cause: '捕获了 CancelledError（裸 except、except BaseException、重试循环里统一捕获）却没有重新抛出。', fix: '捕获 CancelledError 只做清理和记录，然后 raise；重试只针对明确列出的网络错误类型。用测试覆盖“取消后状态正确且异常继续向上传播”。' },
    { symptom: '本地流式输出正常，部署后变成等很久再一次性出现全部文字', cause: '某一层在缓冲：客户端用 read(n) 等凑满、服务端启用了 gzip 压缩中间件、反向代理（例如 nginx）默认缓冲响应。', fix: '客户端用 read1 或 SDK 的流式迭代器；SSE 路由不走压缩；响应头加 cache-control: no-cache 和 x-accel-buffering: no，或在代理上关闭缓冲；用 curl -N 在每一层分别验证。' },
    { symptom: '偶发 UnicodeDecodeError，或 Windows 上一重定向输出就报 UnicodeEncodeError: \'charmap\' codec can\'t encode characters', cause: '对每个网络块单独 decode，汉字被切开；或 stdout 被重定向时使用了系统区域编码而不是 UTF-8。', fix: '用增量解码器（codecs.getincrementaldecoder）；入口处 reconfigure(encoding="utf-8") 或设置环境变量 PYTHONUTF8=1。' },
    { symptom: 'sqlite3.ProgrammingError: SQLite objects created in a thread can only be used in that same thread，或高并发时 database is locked', cause: 'sqlite3 连接默认绑定创建它的线程；FastAPI 的同步接口、to_thread 都会换线程。多个连接同时写时，SQLite 只允许一个写者。', fix: '所有操作留在同一线程，或每个线程一个连接；开启 WAL 并设置 busy_timeout；真正多进程、多实例部署时换 PostgreSQL 和异步驱动。' },
    { symptom: '为了“提高并发”把 Agent 服务改成多线程甚至多进程，复杂度上去了，吞吐没变化', cause: '误以为 GIL 限制了并发。等待模型和数据库时线程会释放 GIL，asyncio 单线程就能同时等成百上千个请求；瓶颈通常在模型服务的限流。', fix: '先测量：看事件循环是否被阻塞、CPU 是否打满。只有本地 embedding、大文档解析这类 CPU 密集任务才放进进程池或独立服务。' },
  ],
  exercises: [
    { id: 't-py-fastapi', text: 'Python 版加 HTTP 服务：用 FastAPI 实现创建 run、审批和 SSE 事件流三个接口', detail: '要求：支持 Last-Event-ID 续传；客户端断开不取消 run；用 httpx 的 ASGI 传输或 TestClient 写测试，覆盖越权访问别人的 run 返回 404。' },
    { id: 't-py-pydantic', text: '用 pydantic 重写三个工具的参数：schema 由 model_json_schema 生成，现有 21 个测试全部通过', detail: '比较生成的 schema 与手写 schema 的差异（例如 title、default 字段），说明哪些差异会影响模型的调用行为，并决定是否保留。' },
    { id: 't-py-context', text: '把第 13 章的上下文预算与工具结果清除移植到 Python 版，并写测试证明清除只影响发给模型的视图、不改事件日志' },
    { id: 't-py-trace-parity', text: '写一个跨语言一致性测试：同一组脚本模型回复下，TS 版和 Python 版产生的事件类型序列与工具结果完全一致', detail: '提示：两边都支持脚本模型；用 node -e 跑 TS 版并输出事件 JSON，在 Python 测试里比对。注意去掉 runId、时间戳、草稿编号这类每次不同的字段。' },
    { id: 't-py-langgraph', text: '用 LangGraph 的 interrupt 和 SQLite checkpointer 重写审批流程，跑通 8 条评测用例，并列出与手写版本相比你失去和得到的控制点' },
  ],
  deeper: { stageId: 'from-scratch', text: '深入专题：从零手写 Agent' },
  interview: [
    { q: 'Python asyncio 和 Node 的事件循环，写 Agent 服务时最大的差别是什么？', a: [
      '模型都是单线程协作式调度，只在 await 处切换。差别在生态默认值：Node 的 IO API 天生非阻塞，Python 标准库和很多常用库（requests、同步数据库驱动）是阻塞的，在协程里误用会让整个进程停住。',
      '所以 Python 服务要么全链路用异步库，要么把阻塞调用明确放进线程池，并用调试模式或监控事件循环延迟来发现漏网之鱼。',
    ] },
    { q: '怎么取消一个正在流式输出的 LLM 调用？Python 里要注意什么？', a: [
      'task.cancel() 会在下一个 await 点抛出 CancelledError。如果底层是异步 HTTP 客户端，连接会随之关闭；如果是放在线程里的阻塞 IO，线程不会被打断，要在 finally 里关闭 socket 让它返回。',
      '捕获 CancelledError 只能做清理（例如写入 cancelled 状态），然后必须重新抛出，否则 asyncio.timeout、TaskGroup 都会失效。用户取消永远不重试；超时抛 TimeoutError，可以按策略重试。',
      '要区分“用户取消”和“服务重启”：前者结束 run，后者保持 running 等恢复。可以用 cancel 的消息参数或单独的停机标志区分。',
    ] },
    { q: 'GIL 会限制 Python Agent 服务的并发吗？', a: [
      'Agent 服务的主要时间花在等模型、等数据库、等工具，是 IO 密集型；线程在等待 IO 时释放 GIL，asyncio 单线程就能同时处理大量请求，GIL 基本不是瓶颈。',
      '受影响的是 CPU 密集部分：本地 embedding 或重排序模型、大文档解析、大量 JSON 处理。这些放进进程池或独立的推理服务；要用多核处理请求就开多个 worker 进程。',
    ] },
    { q: '团队用 Python，你会直接上 LangGraph 或 Pydantic AI，还是自己写循环？', a: [
      '先列出不能让步的性质：权限在服务端过滤、写操作需要审批且幂等、每一步可审计和恢复、评测门禁可以离线运行。然后看框架是否让这些性质更容易实现和测试，而不是只看示例代码短。',
      '框架擅长的是通用部分（状态图、checkpoint、流式、多模型适配）；业务规则（谁能看什么、什么操作要确认）仍然要自己写并用测试锁住。自己写的核心循环只有两三百行，团队完全理解它，也是一种优势。',
      '无论选哪种，都保留与语言、框架无关的评测集：换框架后跑同一套评测，critical 全过才上线。',
    ] },
  ],
};
