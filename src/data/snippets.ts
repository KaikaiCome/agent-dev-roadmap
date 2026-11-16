export interface Snippet {
  id: string;
  title: string;
  language: string;
  description: string;
  code: string;
}

const agentLoop = `// npm i openai   运行：DEEPSEEK_API_KEY=... npx tsx agent.ts "列出当前目录"
import OpenAI from 'openai';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

type Msg = OpenAI.Chat.ChatCompletionMessageParam;
const client = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY });
const LOG = 'session.jsonl';
const MAX_STEPS = 20;

// 1. 工具：schema 是写给模型看的 API
const tools: OpenAI.Chat.ChatCompletionTool[] = [
  fn('read_file', '读取文本文件内容', { path: { type: 'string' } }),
  fn('write_file', '覆盖写入文本文件', { path: { type: 'string' }, content: { type: 'string' } }),
  fn('list_dir', '列出目录条目', { path: { type: 'string' } }),
  fn('bash', '执行 shell 命令，执行前需用户确认', { command: { type: 'string' } }),
];

async function runTool(name: string, args: Record<string, string>): Promise<string> {
  switch (name) {
    case 'read_file': return readFileSync(args.path, 'utf8');
    case 'write_file': writeFileSync(args.path, args.content); return 'ok';
    case 'list_dir': return readdirSync(args.path).join('\\n');
    case 'bash': {
      if (!(await confirm(\`执行 \${args.command} ?\`))) return '用户拒绝执行';
      return execSync(args.command, { encoding: 'utf8', timeout: 60_000 });
    }
    default: throw new Error(\`未知工具 \${name}\`);
  }
}

// 2. 事件日志是唯一事实来源，历史从日志推导
function append(msg: Msg) { appendFileSync(LOG, JSON.stringify(msg) + '\\n'); }
function deriveMessages(): Msg[] {
  try { return readFileSync(LOG, 'utf8').trim().split('\\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

// 3. Agent 循环
async function run(task: string, signal: AbortSignal) {
  append({ role: 'user', content: task });
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.chat.completions.create(
      { model: 'deepseek-chat', messages: [{ role: 'system', content: '你是一个 coding agent。' }, ...deriveMessages()], tools },
      { signal },
    );
    const msg = res.choices[0].message;
    append(msg);
    if (!msg.tool_calls?.length) { console.log(msg.content); return; }

    // 同一步的多个工具调用并行执行；错误回传给模型而不是崩溃
    const results = await Promise.all(msg.tool_calls.map(async (call) => {
      if (call.type !== 'function') return { id: call.id, out: '不支持的调用类型' };
      try { return { id: call.id, out: await runTool(call.function.name, JSON.parse(call.function.arguments)) }; }
      catch (e) { return { id: call.id, out: \`错误: \${(e as Error).message}\` }; }
    }));
    for (const r of results) append({ role: 'tool', tool_call_id: r.id, content: r.out.slice(0, 20_000) });
  }
  console.log(\`达到最大步数 \${MAX_STEPS}\`);
}

function fn(name: string, description: string, properties: Record<string, object>): OpenAI.Chat.ChatCompletionTool {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required: Object.keys(properties) } } };
}
async function confirm(q: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q + ' [y/N] '); rl.close(); return a.trim().toLowerCase() === 'y';
}

const ac = new AbortController();
process.on('SIGINT', () => ac.abort());
await run(process.argv[2] ?? '你好', ac.signal);
`;

const eventReducer = `// 后端推送 agent 事件，前端把事件流 reduce 成 UI 状态
type AgentEvent =
  | { seq: number; type: 'assistant/delta'; text: string }
  | { seq: number; type: 'assistant/done' }
  | { seq: number; type: 'tool/call'; id: string; name: string; args: unknown }
  | { seq: number; type: 'tool/result'; id: string; ok: boolean; output: string }
  | { seq: number; type: 'approval/request'; id: string; command: string };

type Node =
  | { kind: 'text'; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; name: string; args: unknown; status: 'running' | 'ok' | 'error'; output?: string }
  | { kind: 'approval'; id: string; command: string };

interface State { lastSeq: number; nodes: Node[] }

export function reduce(state: State, e: AgentEvent): State {
  if (e.seq <= state.lastSeq) return state; // 重连后重复事件直接丢弃
  const nodes = [...state.nodes];
  const last = nodes.at(-1);
  switch (e.type) {
    case 'assistant/delta':
      if (last?.kind === 'text' && last.streaming) nodes[nodes.length - 1] = { ...last, text: last.text + e.text };
      else nodes.push({ kind: 'text', text: e.text, streaming: true });
      break;
    case 'assistant/done':
      if (last?.kind === 'text') nodes[nodes.length - 1] = { ...last, streaming: false };
      break;
    case 'tool/call':
      nodes.push({ kind: 'tool', id: e.id, name: e.name, args: e.args, status: 'running' });
      break;
    case 'tool/result': {
      const i = nodes.findIndex((n) => n.kind === 'tool' && n.id === e.id);
      if (i >= 0) nodes[i] = { ...(nodes[i] as Extract<Node, { kind: 'tool' }>), status: e.ok ? 'ok' : 'error', output: e.output };
      break;
    }
    case 'approval/request':
      nodes.push({ kind: 'approval', id: e.id, command: e.command });
      break;
    default: {
      const never: never = e;
      return never;
    }
  }
  return { lastSeq: e.seq, nodes };
}

// 订阅：断线后带上 lastSeq 重连，服务端从该序号之后补发
export function useAgentStream(sessionId: string) {
  const [state, dispatch] = useReducer(reduce, { lastSeq: 0, nodes: [] });
  const lastSeq = useRef(0);
  lastSeq.current = state.lastSeq;
  useEffect(() => {
    let es: EventSource;
    const connect = () => {
      es = new EventSource(\`/api/sessions/\${sessionId}/events?after=\${lastSeq.current}\`);
      es.onmessage = (m) => dispatch(JSON.parse(m.data));
      es.onerror = () => { es.close(); setTimeout(connect, 1000); };
    };
    connect();
    return () => es.close();
  }, [sessionId]);
  return state;
}
`;

export const snippets: Record<string, Snippet> = {
  'agent-loop': {
    id: 'agent-loop',
    title: '最小 coding agent（约 80 行）',
    language: 'typescript',
    description: '包含工具定义、并行工具调用、错误回传、bash 审批、最大步数、取消，以及从 JSONL 事件日志推导历史。从这里开始扩展到 500–800 行。',
    code: agentLoop,
  },
  'event-reducer': {
    id: 'event-reducer',
    title: '事件流 reducer 与断线重连',
    language: 'tsx',
    description: '把后端事件 reduce 成可渲染节点（文本、工具卡片、审批）。用序号去重，断线后从 lastSeq 续传。',
    code: eventReducer,
  },
};
