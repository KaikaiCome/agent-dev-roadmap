import { fileURLToPath } from 'node:url';
import { resolveApproval, runAgent } from '../agent.ts';
import { findUser } from '../data/seed.ts';
import type { AgentEvent } from '../events.ts';
import { createScriptedModel } from '../llm/mock.ts';
import type { ChatModel, Message } from '../llm/types.ts';
import { Store } from '../store.ts';
import type { SandboxRunner } from './sandbox.ts';
import { codingPrompt, codingTools, type ApprovalMode } from './tools.ts';
import { disposableCopy, openWorkspace } from './workspace.ts';

// 第 20 章的离线演示：一个故意写了两个 bug 的小项目 + 一个照剧本行动的假模型。
// 剧本是预先写好的（包括一次故意失败的修改），它证明的是工具、沙箱、审批和“测试驱动循环”这条链路，不代表模型修 bug 的能力。

export const buggyCalcFixture = fileURLToPath(new URL('../../examples/fixtures/buggy-calc', import.meta.url));

const test = { name: 'run_command', args: { command: 'node --test' } };

function lastToolResult(messages: Message[]): { ok: boolean; data?: { exitCode?: number | null }; error?: { code: string } } {
  const last = messages.findLast((m) => m.role === 'tool');
  return last ? JSON.parse(last.content) : { ok: false };
}

export function createCodingDemoModel(): ChatModel {
  return createScriptedModel([
    { content: '先运行测试，确认失败的现象。', toolCalls: [test] },
    { content: '有测试失败。看一下项目里有哪些文件，并读实现。', toolCalls: [{ name: 'list_files', args: {} }, { name: 'read_file', args: { path: 'calc.js' } }] },
    // 故意给一个在文件里出现两次的 old_string，演示“必须恰好匹配一次”如何防止改错地方
    { content: 'add 用了减号，改成加号。', toolCalls: [{ name: 'edit_file', args: { path: 'calc.js', old_string: '  return a - b;', new_string: '  return a + b;' } }] },
    (messages) => lastToolResult(messages).error?.code === 'AMBIGUOUS_MATCH'
      ? { content: '这段代码在 subtract 里也有，带上函数签名再改。', toolCalls: [{ name: 'edit_file', args: { path: 'calc.js', old_string: 'export function add(a, b) {\n  return a - b;', new_string: 'export function add(a, b) {\n  return a + b;' } }] }
      : { content: '修改已完成，重新运行测试。', toolCalls: [test] },
    { content: '重新运行测试。', toolCalls: [test] },
    (messages) => lastToolResult(messages).data?.exitCode === 0
      ? { content: '测试已全部通过。' }
      : { content: '还剩空数组求平均值的用例：除以 0 得到 NaN。', toolCalls: [{ name: 'edit_file', args: { path: 'calc.js', old_string: '  return total / numbers.length;', new_string: '  return numbers.length === 0 ? 0 : total / numbers.length;' } }] },
    { content: '再运行一次测试。', toolCalls: [test] },
    (messages) => lastToolResult(messages).data?.exitCode === 0
      ? { content: '修复完成：calc.js 中 add 把减号改为加号；average 对空数组返回 0。node --test 4 个测试全部通过。' }
      : { content: '测试仍然失败，我没能修好，请人工查看。' },
  ]);
}

export interface CodingTaskOptions {
  /** 被复制到临时目录的项目 */
  source?: string;
  model?: ChatModel;
  approval?: ApprovalMode;
  runner?: SandboxRunner;
  task?: string;
  /** 审批模式下，每次暂停时调用；返回 true 表示批准 */
  approve?: (request: Extract<AgentEvent, { type: 'approval_requested' }>['data']) => boolean | Promise<boolean>;
}

/** 在一次性的工作区副本上跑一次编码任务。返回后工作区仍在，调用方看完结果要 dispose */
export async function runCodingTask(options: CodingTaskOptions = {}) {
  const { source = buggyCalcFixture, approval = 'auto', runner, task = '运行测试，修复 calc.js 里的 bug，直到测试全部通过。' } = options;
  const copy = await disposableCopy(source);
  try {
    const workspace = await openWorkspace(copy.dir);
    const store = new Store(':memory:');
    const user = findUser('alice')!;
    const run = store.createRun(user, task);
    const agentOptions = {
      model: options.model ?? createCodingDemoModel(),
      store,
      tools: codingTools({ workspace, approval, runner }),
      systemPrompt: codingPrompt,
      maxSteps: 12,
    };
    let status = await runAgent(run.id, user, agentOptions);
    while (status === 'waiting_approval' && options.approve) {
      const events = store.events(run.id);
      const resolved = new Set(events.flatMap((e) => (e.type === 'approval_resolved' ? [e.data.callId] : [])));
      for (const event of events) {
        if (event.type !== 'approval_requested' || resolved.has(event.data.callId)) continue;
        resolveApproval(store, run.id, user, event.data.callId, await options.approve(event.data));
      }
      status = await runAgent(run.id, user, agentOptions);
    }
    return { status, events: store.events(run.id), workspace: copy.dir, dispose: copy.dispose };
  } catch (error) {
    await copy.dispose();
    throw error;
  }
}
