import type { Snippet } from './snippets';
import type { training } from './training';

export const trainingExamples = {
  intuition: {
    id: 'training-fixture',
    title: '起步代码：无密钥模型替身',
    language: 'javascript',
    description: '保存为 fixture.mjs，运行 node --test fixture.mjs。仅用 Node 内置模块，可直接离线运行；它是实验 0 的响应替身与测试起点，不是完整 HTTP 服务。下一步将这些响应接入你的 API。',
    code: `import test from 'node:test';
import assert from 'node:assert/strict';

export async function modelFixture(mode, signal) {
  signal.throwIfAborted();
  switch (mode) {
    case 'answer':
      return { kind: 'text', text: '报销上限为 500 元 [A-public@v1]' };
    case 'tool':
      return {
        kind: 'tool', callId: 'call-1', name: 'search_knowledge',
        arguments: JSON.stringify({ query: '报销上限' }),
      };
    case 'refusal':
      return { kind: 'refusal', reason: '没有可访问的证据' };
    case 'rate-limit':
      throw Object.assign(new Error('供应商限流'), {
        status: 429, retryAfterMs: 1000,
      });
    default:
      throw new Error('未匹配的 fixture，不允许回退到真实模型');
  }
}

test('区分回答、调用与拒答', async () => {
  const signal = new AbortController().signal;
  assert.equal((await modelFixture('answer', signal)).kind, 'text');
  const call = await modelFixture('tool', signal);
  assert.deepEqual(JSON.parse(call.arguments), { query: '报销上限' });
  assert.equal((await modelFixture('refusal', signal)).kind, 'refusal');
});

test('限流和取消不是成功响应', async () => {
  const controller = new AbortController();
  await assert.rejects(modelFixture('rate-limit', controller.signal),
    (error) => error.status === 429);
  controller.abort();
  await assert.rejects(modelFixture('answer', controller.signal),
    (error) => error.name === 'AbortError');
});`,
  },
  'from-scratch': {
    id: 'training-state',
    title: '核心参考：显式状态转换',
    language: 'typescript',
    description: '放在服务端运行域中。此纯函数仅表达转换规则，真实执行必须先检查权限与预算，并用数据库事务/条件更新持久化；函数本身不提供并发控制或工单幂等。',
    code: `type Status = 'queued' | 'running' | 'waiting_approval'
  | 'completed' | 'failed' | 'cancelled';
type Event = 'start' | 'request_approval' | 'approve'
  | 'reject' | 'finish' | 'fail' | 'cancel';

const transitions: Record<Status, Partial<Record<Event, Status>>> = {
  queued: { start: 'running', cancel: 'cancelled', fail: 'failed' },
  running: {
    request_approval: 'waiting_approval', finish: 'completed',
    fail: 'failed', cancel: 'cancelled',
  },
  waiting_approval: {
    approve: 'running', reject: 'cancelled',
    cancel: 'cancelled', fail: 'failed',
  },
  completed: {},
  failed: {},
  cancelled: {},
};

export function transition(status: Status, event: Event): Status {
  const next = transitions[status][event];
  if (!next) throw new Error('非法状态转换: ' + status + ' -> ' + event);
  return next;
}

// 仅在服务端验证 approval 的身份、动作、版本与有效期后发出 approve。
// 练习：用表驱动测试遍历允许转换；再验证 completed 无法再次 start。
// 持久化时 UPDATE runs ... WHERE status = :previous AND version = :version；
// 更新数不是 1 时报告冲突，不继续执行副作用。`,
  },
  'agent-ui': {
    id: 'training-cursor',
    title: '核心参考：事件缺号不直接跳过',
    language: 'typescript',
    description: '输入应先通过运行时 schema 校验。序号约定为单个运行内从 1 连续递增；apply 只处理纯视图状态。遇到 gap 时停止当前流，补齐或获取快照，再从已提交游标继续。用它替换“只忽略旧序号”的不完整方案。',
    code: `type Envelope = { runId: string; seq: number; type: string; payload: unknown };
type CursorState<T> = { runId: string; lastSeq: number; view: T };
type ReceiveResult<T> =
  | { kind: 'applied' | 'duplicate'; state: CursorState<T> }
  | { kind: 'gap'; after: number }
  | { kind: 'wrong_run' };

export function receive<T>(
  state: CursorState<T>,
  event: Envelope,
  apply: (view: T, event: Envelope) => T,
): ReceiveResult<T> {
  if (event.runId !== state.runId) return { kind: 'wrong_run' };
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) {
    throw new Error('无效事件序号');
  }
  if (event.seq <= state.lastSeq) return { kind: 'duplicate', state };
  if (event.seq !== state.lastSeq + 1) {
    return { kind: 'gap', after: state.lastSeq };
  }
  return {
    kind: 'applied',
    state: { ...state, lastSeq: event.seq, view: apply(state.view, event) },
  };
}

// 练习：输入 1、1、3 应得到 applied、duplicate、gap。
// 接着从 after=1 回放 2、3，最终状态应与直接回放 1、2、3 相同。
// 不要在 gap 分支把 lastSeq 设置为 3，否则会永久跳过 2。`,
  },
  'context-tools': {
    id: 'training-query',
    title: '核心参考：检索先授权，再排序',
    language: 'sql',
    description: 'PostgreSQL 参数化查询示意，非完整迁移。表需包含租户、文档版本、片段和访问授权关系；$1/$2 来自认证会话，$3 是已校验的查询，$4 是服务端当前时间。关键词基线使用 simple 分词，中文生产检索需另行评估分词或 embedding。',
    code: `SELECT c.source_id, c.version, c.content
FROM document_chunks c
JOIN documents d
  ON d.tenant_id = c.tenant_id
 AND d.id = c.document_id
 AND d.current_version = c.version
WHERE d.tenant_id = $1
  AND d.deleted_at IS NULL
  AND d.effective_at <= $4
  AND EXISTS (
    SELECT 1
    FROM document_grants g
    WHERE g.tenant_id = d.tenant_id
      AND g.document_id = d.id
      AND g.user_id = $2
      AND g.revoked_at IS NULL
  )
  AND c.search_vector @@ plainto_tsquery('simple', $3)
ORDER BY ts_rank(c.search_vector, plainto_tsquery('simple', $3)) DESC
LIMIT 5;

-- 引用读取也必须重复 tenant / 当前 ACL / 删除与版本检查。
-- 向量召回必须应用等价过滤；不要先召回全库再让模型过滤。
-- 练习：缓存预热后撤销 grant，再执行同一查询与引用读取，均不得返回内容。`,
  },
  'eval-observability': {
    id: 'training-eval',
    title: '起步代码：失败即阻断的评估汇总',
    language: 'javascript',
    description: '保存为 gate.mjs，运行 node gate.mjs results.json。输入为 runner 生成的 30 条逐例结果（id、passed、critical 布尔字段）；权限与审批用例标记 critical。该程序只汇总结果，不替代真实判分；runner 应先校验结果 ID 与预定义用例清单完全匹配。',
    code: `import { readFile } from 'node:fs/promises';

const path = process.argv[2];
if (!path) throw new Error('用法: node gate.mjs results.json');
const rows = JSON.parse(await readFile(path, 'utf8'));
if (!Array.isArray(rows) || rows.length !== 30) {
  throw new Error('必须提供完整 30 条逐例结果');
}
const ids = new Set();
for (const row of rows) {
  if (!row || typeof row.id !== 'string' || row.id.length === 0
      || typeof row.passed !== 'boolean'
      || typeof row.critical !== 'boolean' || ids.has(row.id)) {
    throw new Error('结果格式错误或 ID 重复');
  }
  ids.add(row.id);
}
if (rows.filter((row) => row.critical).length < 10) {
  throw new Error('权限隔离与审批用例未完整标为关键项');
}
const passed = rows.filter((row) => row.passed).length;
const criticalFailures = rows
  .filter((row) => row.critical && !row.passed)
  .map((row) => row.id);
const allowed = passed >= 27 && criticalFailures.length === 0;
console.log(JSON.stringify({ passed, total: rows.length, criticalFailures, allowed }));
process.exitCode = allowed ? 0 : 1;

// 练习：27/30 且关键项全过应退出 0。
// 29/30 但唯一失败是关键项，或只有 26/30 通过，均应退出 1。`,
  },
  advanced: {
    id: 'training-lease',
    title: '核心参考：条件更新拒绝旧 worker',
    language: 'sql',
    description: 'PostgreSQL worker 租约示意。runs 需有 lease_version（初始 0）、lease_until、status、tenant_id 和 id。此示例仅展示 fencing，不代替 outbox、调度、授权或外部系统幂等；每次执行新动作和提交状态前都检查租约。',
    code: `-- 领取 queued 或租约已失效的 running 任务，返回新的 fencing token。
UPDATE runs
SET status = 'running',
    lease_version = lease_version + 1,
    lease_until = clock_timestamp() + interval '30 seconds'
WHERE tenant_id = $1 AND id = $2
  AND (status = 'queued'
    OR (status = 'running' AND lease_until < clock_timestamp()))
RETURNING lease_version;

-- 心跳续租：$3 是领取时取得的版本，旧 worker 不能续租。
UPDATE runs
SET lease_until = clock_timestamp() + interval '30 seconds'
WHERE tenant_id = $1 AND id = $2 AND lease_version = $3
  AND status = 'running' AND lease_until > clock_timestamp();

-- 提交：返回 0 行代表已失去租约，必须停止并上报冲突。
UPDATE runs
SET status = 'completed', lease_until = NULL
WHERE tenant_id = $1 AND id = $2 AND lease_version = $3
  AND status = 'running' AND lease_until > clock_timestamp()
RETURNING id;

-- 事件写入和状态更新须在同一事务内完成。
-- 租约不能撤回已经发出的外部请求，外部仍须用 actionId 幂等并对账。`,
  },
  direction: {
    id: 'training-release',
    title: '交付模板：发布与恢复记录',
    language: 'text',
    description: '把这份模板放入实训仓库的发布记录。每项填写实际结果和证据路径，不预填“通过”；它是毕业答辩的交付格式，不是自动生成的生产合格证明。',
    code: `发布版本 / 代码提交：
模型 / 提示词 hash / 工具 schema / 语料版本：
数据库迁移 / 事件兼容范围：
环境、硬件、网络、模型价格日期与汇率：

质量：开发集 __/__；留出集 __/__；关键边界失败 __
模式：replay / real（分别报告）
容量：并发 5，任务 50；失败 __；排队 p95 __
延迟：首业务事件 p95 __；端到端 p95 __
费用：模型总费用 __；单任务最大费用 __；未知 usage __

副作用关闭开关 / 验证结果：
回滚目标 / 在途任务处理 / 旧事件回放结果：
备份时点 / 恢复耗时 / RPO / RTO：
外部工单对账 / 未知结果处理：

故障演练：
症状 → trace/runId → 根因 → 止损 → 修复 → 回归证据
1.
2.
3.

不支持的场景 / 残余风险：
业务、安全、运维审查结论：
发布决定：允许 / 阻断（原因）
值班责任人与人工升级路径：`,
  },
} satisfies Record<keyof typeof training, Snippet>;
