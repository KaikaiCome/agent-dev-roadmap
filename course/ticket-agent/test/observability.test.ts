import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { resolveApproval, runAgent } from '../src/agent.ts';
import { findUser } from '../src/data/seed.ts';
import { createMockModel } from '../src/llm/mock.ts';
import { createOpenAICompatibleModel } from '../src/llm/openai.ts';
import { createApp } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { AgentTelemetry } from '../src/telemetry/genai.ts';
import { createTelemetry } from '../src/telemetry/index.ts';
import { BatchSpanProcessor } from '../src/telemetry/otlp.ts';
import { computeSlo, percentile } from '../src/telemetry/slo.ts';
import { parseTraceparent, Tracer } from '../src/telemetry/trace.ts';
import { createTools } from '../src/tools/index.ts';

const alice = findUser('alice')!;
const mockModel = { provider: 'mock' as const, baseURL: '' };

interface ReceivedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  status: { code?: number; message?: string };
  attributes: Record<string, unknown>;
}

/** 进程内的 OTLP/HTTP 收集端：记录收到的请求体，可以让它返回错误或一直不响应 */
async function startCollector(mode: 'ok' | 'error' | 'hang' = 'ok') {
  const bodies: any[] = [];
  const pending: IncomingMessage[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    if (mode === 'hang') return pending.push(req);
    bodies.push({ path: req.url, contentType: req.headers['content-type'], json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    res.writeHead(mode === 'ok' ? 200 : 503, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    bodies,
    spans: (): ReceivedSpan[] => bodies.flatMap((b) => b.json.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)))
      .map((span: any) => ({ ...span, attributes: decode(span.attributes) })),
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function decode(attributes: Array<{ key: string; value: any }>): Record<string, unknown> {
  return Object.fromEntries(attributes.map(({ key, value }) => [key, decodeValue(value)]));
}

function decodeValue(value: any): unknown {
  if ('stringValue' in value) return value.stringValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('boolValue' in value) return value.boolValue;
  if ('arrayValue' in value) return value.arrayValue.values.map(decodeValue);
  return decode(value.kvlistValue.values);
}

const byName = (spans: ReceivedSpan[], name: string) => spans.filter((s) => s.name === name);

test('一次 run 产生 invoke_agent → chat / execute_tool 的 span 树，属性名符合 GenAI 语义约定，默认不导出内容', async () => {
  const collector = await startCollector();
  const telemetry = createTelemetry(mockModel, { OTEL_EXPORTER_OTLP_ENDPOINT: collector.base + '/', OTEL_SERVICE_NAME: 'ticket-agent-test' })!;
  const store = new Store(':memory:');
  const question = '我下周去北京出差，住宿能报多少？';
  const run = store.createRun(alice, question);
  assert.equal(await runAgent(run.id, alice, { model: createMockModel(), store, tools: createTools(store), telemetry: telemetry.agent }), 'completed');
  await telemetry.processor.forceFlush();

  assert.equal(collector.bodies[0].path, '/v1/traces');
  assert.equal(collector.bodies[0].contentType, 'application/json');
  assert.deepEqual(collector.bodies[0].json.resourceSpans[0].resource.attributes[0], { key: 'service.name', value: { stringValue: 'ticket-agent-test' } });

  const spans = collector.spans();
  assert.deepEqual(spans.map((s) => s.name).sort(), ['chat mock', 'chat mock', 'execute_tool search_knowledge', 'invoke_agent ticket-agent']);
  const [root] = byName(spans, 'invoke_agent ticket-agent');
  assert.equal(root.parentSpanId, undefined);
  for (const span of spans.filter((s) => s !== root)) {
    assert.equal(span.traceId, root.traceId);
    assert.equal(span.parentSpanId, root.spanId, `${span.name} 是 run 的子 span`);
  }
  assert.deepEqual(
    { ...root.attributes, 'gen_ai.usage.input_tokens': undefined, 'gen_ai.usage.output_tokens': undefined },
    {
      'gen_ai.operation.name': 'invoke_agent', 'gen_ai.provider.name': 'mock', 'gen_ai.agent.name': 'ticket-agent', 'gen_ai.request.model': 'mock',
      'app.run.id': run.id, 'app.tenant.id': 'acme', 'app.run.resumed': false, 'app.run.status': 'completed',
      'gen_ai.usage.input_tokens': undefined, 'gen_ai.usage.output_tokens': undefined,
    },
  );

  const chats = byName(spans, 'chat mock');
  assert.ok(chats.every((s) => s.kind === 3 && s.attributes['gen_ai.operation.name'] === 'chat' && s.attributes['gen_ai.request.model'] === 'mock'));
  assert.deepEqual(chats.map((s) => s.attributes['gen_ai.response.finish_reasons']).sort(), [['stop'], ['tool_calls']]);
  const sum = (key: string) => chats.reduce((total, s) => total + (s.attributes[key] as number), 0);
  assert.equal(root.attributes['gen_ai.usage.input_tokens'], sum('gen_ai.usage.input_tokens'), 'run 的用量 = 各次模型调用之和');
  assert.equal(root.attributes['gen_ai.usage.output_tokens'], sum('gen_ai.usage.output_tokens'));

  const [tool] = byName(spans, 'execute_tool search_knowledge');
  assert.equal(tool.kind, 1);
  assert.deepEqual(Object.keys(tool.attributes).sort(), ['gen_ai.operation.name', 'gen_ai.tool.call.id', 'gen_ai.tool.name', 'gen_ai.tool.type']);
  assert.equal(tool.attributes['gen_ai.operation.name'], 'execute_tool');

  const exported = JSON.stringify(collector.bodies);
  assert.ok(!exported.includes('北京') && !exported.includes('350'), '问题和回答都不出现在导出的数据里');
  assert.ok(!/gen_ai\.(input|output)\.messages|gen_ai\.system_instructions|gen_ai\.tool\.call\.(arguments|result)/.test(exported));
  await telemetry.shutdown();
  await collector.close();
});

test('只有显式开启 OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT 才在 span 上记录提示词、回答和工具参数', async () => {
  assert.equal(createTelemetry(mockModel, {}), undefined, '没有配置收集端时完全不启用');
  assert.equal(createTelemetry(mockModel, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x', OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT: 'true' })!.agent.captureContent, false, '无法识别的值按不记录处理');

  const collector = await startCollector();
  const telemetry = createTelemetry(mockModel, { OTEL_EXPORTER_OTLP_ENDPOINT: collector.base, OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT: 'span_only' })!;
  const store = new Store(':memory:');
  const run = store.createRun(alice, '我下周去北京出差，住宿能报多少？');
  await runAgent(run.id, alice, { model: createMockModel(), store, tools: createTools(store), telemetry: telemetry.agent });
  await telemetry.processor.forceFlush();

  const spans = collector.spans();
  const [first, second] = byName(spans, 'chat mock');
  const input = first.attributes['gen_ai.input.messages'] as Array<{ role: string; parts: Array<{ type: string; content: string }> }>;
  assert.deepEqual(input, [{ role: 'user', parts: [{ type: 'text', content: '我下周去北京出差，住宿能报多少？' }] }]);
  assert.ok((first.attributes['gen_ai.system_instructions'] as Array<{ content: string }>)[0].content.length > 0);
  assert.ok(JSON.stringify(second.attributes['gen_ai.output.messages']).includes('350'));
  const [tool] = byName(spans, 'execute_tool search_knowledge');
  assert.ok(String(tool.attributes['gen_ai.tool.call.arguments']).includes('北京'));
  assert.ok(String(tool.attributes['gen_ai.tool.call.result']).includes('acme-travel@v2'));
  await collector.close();
});

test('子 Agent 的 run 作为子 span 挂在父 run 的 execute_tool research 下面，同一条 trace', async () => {
  const collector = await startCollector();
  const telemetry = createTelemetry(mockModel, { OTEL_EXPORTER_OTLP_ENDPOINT: collector.base })!;
  const store = new Store(':memory:');
  const run = store.createRun(alice, '我下周去北京出差，住宿能报多少？');
  const tools = createTools(store, { subagent: { model: createMockModel() } });
  assert.equal(await runAgent(run.id, alice, { model: createMockModel(), store, tools, telemetry: telemetry.agent }), 'completed');
  await telemetry.processor.forceFlush();

  const spans = collector.spans();
  const [root] = byName(spans, 'invoke_agent ticket-agent');
  const [delegate] = byName(spans, 'execute_tool research');
  const [child] = byName(spans, 'invoke_agent research');
  assert.equal(delegate.parentSpanId, root.spanId);
  assert.equal(child.parentSpanId, delegate.spanId);
  assert.equal(child.attributes['app.run.parent_id'], run.id);
  assert.equal(child.attributes['app.run.id'], store.childRuns(run.id)[0].id);
  assert.equal(byName(spans, 'execute_tool search_knowledge')[0].parentSpanId, child.spanId, '子 Agent 的检索挂在子 run 下');
  assert.equal(spans.filter((s) => s.parentSpanId === child.spanId && s.name === 'chat mock').length, 2);
  assert.ok(spans.every((s) => s.traceId === root.traceId));
  await collector.close();
});

test('审批暂停的工具调用不产生 execute_tool span；恢复后补记 approval_wait，两段 run 都有记录', async () => {
  const collector = await startCollector();
  const telemetry = createTelemetry(mockModel, { OTEL_EXPORTER_OTLP_ENDPOINT: collector.base })!;
  const store = new Store(':memory:');
  const run = store.createRun(alice, 'VPN 连不上，帮我提交一个工单');
  const options = { model: createMockModel(), store, tools: createTools(store), telemetry: telemetry.agent };
  assert.equal(await runAgent(run.id, alice, options), 'waiting_approval');
  await new Promise((resolve) => setTimeout(resolve, 40));
  const request = store.events(run.id).find((e) => e.type === 'approval_requested');
  assert.ok(request?.type === 'approval_requested');
  resolveApproval(store, run.id, alice, request.data.callId, true);
  assert.equal(await runAgent(run.id, alice, options), 'completed');
  await telemetry.processor.forceFlush();

  const spans = collector.spans();
  const segments = byName(spans, 'invoke_agent ticket-agent');
  assert.deepEqual(segments.map((s) => [s.attributes['app.run.status'], s.attributes['app.run.resumed']]), [['waiting_approval', false], ['completed', true]]);
  const [wait] = byName(spans, 'approval_wait create_ticket');
  assert.equal(wait.parentSpanId, segments[1].spanId);
  assert.equal(wait.attributes['app.approval.approved'], true);
  const waitedMs = (Number(BigInt((wait as any).endTimeUnixNano) - BigInt((wait as any).startTimeUnixNano))) / 1e6;
  assert.ok(waitedMs >= 30, `审批等待 ${waitedMs}ms`);
  const created = byName(spans, 'execute_tool create_ticket');
  assert.equal(created.length, 1, '只有真正执行的那一次');
  assert.equal(created[0].parentSpanId, segments[1].spanId);
  await collector.close();
});

test('traceparent：入站请求的上下文成为 run 的父 span，出站模型请求带上 chat span 的上下文', async () => {
  assert.equal(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')?.sampled, true);
  for (const bad of ['', 'garbage', 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
    '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01', '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra']) {
    assert.equal(parseTraceparent(bad), undefined, bad);
  }

  const outgoing: Array<string | null> = [];
  const model = createOpenAICompatibleModel({
    baseURL: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-chat',
    fetchImpl: async (_url, init) => {
      outgoing.push(new Headers(init?.headers).get('traceparent'));
      const chunks = [{ choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }];
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  const collector = await startCollector();
  const telemetry = createTelemetry({ provider: 'openai', baseURL: 'https://api.deepseek.com' }, { OTEL_EXPORTER_OTLP_ENDPOINT: collector.base })!;
  const store = new Store(':memory:');
  const app = createApp({ store, model, tools: [], allowedOrigin: 'http://localhost:5173', telemetry: telemetry.agent });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173', ...headers }, body: JSON.stringify(body),
  });
  const cookie = (await post('/api/login', { userId: 'alice' })).headers.get('set-cookie')!.split(';')[0];
  const ask = async (traceparent?: string) => {
    const { runId } = await (await post('/api/runs', { question: '你好' }, { cookie, ...(traceparent ? { traceparent } : {}) })).json() as { runId: string };
    while (store.getRun(runId)!.status === 'running') await new Promise((resolve) => setTimeout(resolve, 5));
    return runId;
  };

  const upstream = { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' };
  await ask(`00-${upstream.traceId}-${upstream.spanId}-01`);
  await ask('not-a-traceparent');
  await ask(`00-${'a'.repeat(32)}-${upstream.spanId}-00`);
  await telemetry.processor.forceFlush();
  await app.shutdown();

  const spans = collector.spans();
  const roots = byName(spans, 'invoke_agent ticket-agent');
  assert.equal(roots.length, 2, '上游标记为不采样（flags=00）的 run 不导出');
  assert.deepEqual([roots[0].traceId, roots[0].parentSpanId], [upstream.traceId, upstream.spanId]);
  assert.ok(roots[1].traceId !== upstream.traceId && roots[1].parentSpanId === undefined, '无法解析的 traceparent 当作没有，开新 trace');

  const chats = byName(spans, 'chat deepseek-chat');
  assert.deepEqual(chats[0].attributes['server.address'], 'api.deepseek.com');
  assert.equal(chats[0].attributes['gen_ai.provider.name'], 'deepseek');
  assert.equal(chats[0].attributes['gen_ai.usage.input_tokens'], 9);
  assert.equal(outgoing[0], `00-${upstream.traceId}-${chats[0].spanId}-01`, '模型服务收到的父 span 是 chat span');
  assert.equal(outgoing[2], `00-${'a'.repeat(32)}-${outgoing[2]!.slice(36, 52)}-00`, '不采样的决定继续往下游传');

  // 关闭遥测时出站请求和以前完全一样
  const run = store.createRun(alice, '你好');
  await runAgent(run.id, alice, { model, store, tools: [] });
  assert.equal(outgoing.at(-1), null);
  await collector.close();
});

test('收集端报错、挂起或不可达都不影响 run；队列有上限，超出的 span 被丢弃并计数', async () => {
  for (const mode of ['error', 'hang', 'down'] as const) {
    const collector = await startCollector(mode === 'down' ? 'ok' : mode);
    if (mode === 'down') await collector.close();
    const processor = new BatchSpanProcessor({ url: collector.base + '/v1/traces', resource: { 'service.name': 't' }, timeoutMs: 200, scheduledDelayMs: 1, maxQueueSize: 3 });
    const telemetry = new AgentTelemetry({ tracer: new Tracer({ processor }), provider: 'mock' });
    const store = new Store(':memory:');
    const run = store.createRun(alice, '我下周去北京出差，住宿能报多少？');
    const started = performance.now();
    assert.equal(await runAgent(run.id, alice, { model: createMockModel(), store, tools: createTools(store), telemetry }), 'completed', mode);
    assert.ok(performance.now() - started < 150, `${mode}：run 不等待导出`);
    await processor.forceFlush();
    assert.equal(processor.stats.exported, 0, mode);
    assert.ok(processor.stats.failedRequests >= 1, mode);
    assert.equal(processor.stats.dropped, 4, `${mode}：4 个 span 全部丢弃（排队时或发送失败后）`);
    if (mode !== 'down') await collector.close();
  }
});

test('SLO 从事件日志计算：子 Agent 成本算到根 run，审批等待不计入延迟，取消不计入，卡住算失败', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE runs (id TEXT, status TEXT, created_at TEXT);
    CREATE TABLE events (run_id TEXT, seq INTEGER, type TEXT, data TEXT, created_at TEXT);
    CREATE TABLE run_links (child_run_id TEXT, parent_run_id TEXT)`);
  const at = (s: number) => new Date(Date.UTC(2025, 0, 1) + s * 1000).toISOString();
  const run = (id: string, status: string, start: number, events: Array<[number, string, object]>) => {
    db.prepare('INSERT INTO runs VALUES (?, ?, ?)').run(id, status, at(start));
    events.forEach(([s, type, data], i) => db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)').run(id, i + 1, type, JSON.stringify(data), at(s)));
  };
  const usage = { inputTokens: 1_000_000, outputTokens: 0 };
  run('a', 'completed', 0, [[1, 'usage', usage], [2, 'approval_requested', { callId: 'c1' }], [302, 'approval_resolved', { callId: 'c1' }], [310, 'run_finished', {}]]);
  run('a-child', 'completed', 5, [[6, 'usage', usage]]);
  db.prepare('INSERT INTO run_links VALUES (?, ?)').run('a-child', 'a');
  run('b', 'completed', 10, [[30, 'run_finished', {}]]);
  run('c', 'failed', 20, [[21, 'run_finished', { reason: '模型调用失败' }]]);
  run('d', 'cancelled', 30, [[31, 'run_finished', {}]]);
  run('e', 'running', 40, []);

  const report = computeSlo(db, {
    from: new Date(at(0)), to: new Date(at(40 + 11 * 60)), prices: { input: 2, output: 8 },
    successTarget: 0.5, latencyP95Ms: 15_000, stuckAfterMs: 10 * 60_000, burnWindowsHours: [1],
  });
  assert.equal(report.runs, 5);
  assert.deepEqual(report.excluded, { cancelled: 1 });
  assert.deepEqual([report.good, report.bad], [2, 2]);
  assert.deepEqual([report.latency.p50, report.latency.p95, report.latency.wallP95], [10_000, 20_000, 310_000]);
  assert.equal(report.latency.slowRatio, 0.5);
  assert.deepEqual([report.cost.total, report.cost.p95], [4, 4]);
  assert.equal(report.budget.consumed, 1);
  assert.deepEqual(report.burn, [{ hours: 1, runs: 4, bad: 2, rate: 1 }]);
  assert.deepEqual(report.topReasons, [['failed：模型调用失败', 1], ['卡住：超过 10 分钟未结束', 1]]);
  assert.deepEqual([percentile([], 0.95), percentile([3, 1, 2], 0.5)], [0, 2]);
});
