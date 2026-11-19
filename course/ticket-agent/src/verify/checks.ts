import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ChapterChecks, Check } from './runner.ts';

const node = process.execPath;
const nodeTest = (...files: string[]): string[] => [node, '--test', ...files.map((file) => `test/${file}.test.ts`)];
const evalGate = (name: string, env: Record<string, string> = {}): Check => ({
  name,
  argv: [node, 'src/eval/run.ts'],
  env,
  expect: /可以发布/,
});
const needs = (path: string, install: string) => () => (existsSync(path) ? undefined : `未安装依赖，先运行 ${install}`);

function findPython(): string | undefined {
  for (const command of ['python3', 'python', 'py']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true });
    const match = /Python 3\.(\d+)/.exec(`${result.stdout}${result.stderr}`);
    if (result.status === 0 && match && Number(match[1]) >= 11) return command;
  }
  return undefined;
}

/**
 * 每章的验收标准：这一章的测试 + 这一章的门禁脚本。门禁脚本都按“不达标就非零退出”设计，
 * 所以学员改坏了代码（或者完成练习时引入了回归）会在这里直接暴露，而不是靠自己勾选“已完成”。
 */
export function chapterChecks(): ChapterChecks[] {
  const python = findPython();
  return [
    {
      id: 'basics',
      title: '基础篇（第 1–11 章）',
      checks: [
        { name: '严格类型检查', argv: [node, 'node_modules/typescript/bin/tsc', '-p', '.'], skip: needs('node_modules/typescript', 'npm install') },
        { name: '模型适配、检索权限、审批、状态与 HTTP 测试', argv: nodeTest('llm', 'knowledge', 'agent', 'lifecycle', 'server', 'eval') },
        evalGate('评测门禁（默认配置）'),
      ],
    },
    {
      id: 'mcp',
      title: '第 12 章 MCP 服务',
      checks: [{ name: 'MCP 服务测试', argv: [node, '--test', 'test/*.test.ts'], cwd: 'mcp', skip: needs('mcp/node_modules', 'npm ci --prefix mcp') }],
    },
    {
      id: 'advanced',
      title: '第 13–15 章 上下文工程、LLM 评审、性能与可靠性',
      checks: [{ name: '高级篇测试', argv: nodeTest('advanced') }],
    },
    {
      id: 'frontier',
      title: '第 17 章 生产难点地图',
      checks: [{ name: '检索基准可运行', argv: [node, 'examples/03-retrieval-bench.ts'], expect: /recall@3/ }],
    },
    {
      id: 'hybrid-rag',
      title: '第 18 章 混合检索',
      checks: [
        { name: '检索测试', argv: nodeTest('retrieval') },
        { name: '混合检索基准', argv: [node, 'examples/05-hybrid-bench.ts'] },
        evalGate('评测门禁（RETRIEVAL=hybrid）', { RETRIEVAL: 'hybrid' }),
      ],
    },
    {
      id: 'subagents-memory',
      title: '第 19 章 子 Agent 与长期记忆',
      checks: [
        { name: '子 Agent 与记忆测试', argv: nodeTest('subagent', 'memory') },
        { name: '记忆基准', argv: [node, 'examples/06-memory-bench.ts'] },
        evalGate('评测门禁（SUBAGENT=on MEMORY=on）', { SUBAGENT: 'on', MEMORY: 'on' }),
      ],
    },
    {
      id: 'coding-agent',
      title: '第 20 章 编码 Agent 与沙箱',
      checks: [
        { name: '沙箱与编码工具测试', argv: nodeTest('coding') },
        { name: '离线演示从红到绿', argv: [node, 'examples/07-coding-agent.ts'] },
      ],
    },
    {
      id: 'red-team',
      title: '第 21 章 红队测试与护栏',
      checks: [
        { name: '护栏测试', argv: nodeTest('redteam') },
        { name: '红队门禁（critical 攻击必须全部拦截）', argv: [node, 'examples/09-redteam.ts'] },
        evalGate('评测门禁（GUARDRAILS=on，正常请求不被误拦）', { GUARDRAILS: 'on' }),
      ],
    },
    {
      id: 'observability',
      title: '第 22 章 可观测性',
      checks: [
        { name: '追踪与导出测试', argv: nodeTest('observability') },
        { name: 'SLO 报表', argv: [node, 'examples/08-slo.ts'] },
      ],
    },
    {
      id: 'distributed',
      title: '第 23 章 分布式运行',
      checks: [
        { name: '队列、租约、栅栏与 outbox 测试', argv: nodeTest('distributed') },
        { name: '混沌测试（不丢不重）', argv: [node, 'examples/13-chaos.ts'] },
      ],
    },
    {
      id: 'real-model',
      title: '第 24 章 真实模型下的可靠性',
      checks: [
        { name: 'pass^k、录制回放与结构化输出测试', argv: nodeTest('reliability') },
        { name: 'pass^k 门禁（K=3）', argv: [node, 'src/eval/run-k.ts'], env: { K: '3' } },
        { name: '结构化输出修复循环', argv: [node, 'examples/12-structured.ts'] },
      ],
    },
    {
      id: 'model-side',
      title: '第 25 章 模型侧',
      checks: [
        { name: '训练数据导出测试', argv: nodeTest('training') },
        { name: '导出 SFT 与偏好数据', argv: [node, 'examples/10-training-data.ts'] },
      ],
    },
    {
      id: 'frameworks',
      title: '第 26 章 框架对比',
      checks: [{ name: '框架子项目测试', argv: [node, '--test', 'test/*.test.ts'], cwd: 'frameworks', skip: needs('frameworks/node_modules', 'npm ci --prefix frameworks') }],
    },
    {
      id: 'python-port',
      title: '第 27 章 Python 版本（可选）',
      checks: [
        {
          name: 'Python 单元测试',
          argv: [python ?? 'python', '-m', 'unittest', 'discover', '-s', 'tests', '-t', '.'],
          cwd: 'python',
          skip: () => (python ? undefined : '没有找到 Python 3.11+'),
        },
      ],
    },
    {
      id: 'paradigms',
      title: '第 28 章 工作范式',
      checks: [
        { name: 'Agent Loop / Harness / Graph 测试', argv: nodeTest('paradigms') },
        { name: '三种范式对比演示', argv: [node, 'examples/14-paradigms.ts'], expect: /Graph（混合）\s+2\s+是\s+1/ },
      ],
    },
  ];
}
