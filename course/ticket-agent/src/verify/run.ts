import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chapterChecks } from './checks.ts';
import { runChecks, selectChapters, summarize, type CheckResult } from './runner.ts';

// 本地验收：npm run verify [-- 章节 id ...] [--json 报告路径]
// 不读取 .env，并强制使用离线模型：验收结果只取决于代码，不取决于网络、密钥和服务商当天的状态

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined;
const ids = args.filter((arg, index) => !arg.startsWith('--') && (jsonIndex < 0 || index !== jsonIndex + 1));

const all = chapterChecks();
if (args.includes('--list')) {
  for (const chapter of all) console.log(`${chapter.id.padEnd(18)}${chapter.title}`);
  process.exit(0);
}

let chapters;
try {
  chapters = selectChapters(all, ids);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

const overrides: Record<string, string | undefined> = {
  MODEL_PROVIDER: 'mock',
  EMBEDDING_PROVIDER: 'mock',
  RETRIEVAL: undefined,
  SUBAGENT: undefined,
  MEMORY: undefined,
  GUARDRAILS: undefined,
  RUN_MODE: undefined,
  OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
  K: undefined,
  NODE_OPTIONS: undefined,
};
const baseEnv: Record<string, string> = {};
for (const [key, value] of Object.entries({ ...process.env, ...overrides })) {
  if (value !== undefined) baseEnv[key] = value;
}

const titles = new Map(chapters.map((chapter) => [chapter.id, chapter.title]));
let current = '';
const mark = { pass: '✔', fail: '✖', skip: '○' } as const;
const print = (result: CheckResult) => {
  if (result.chapter !== current) {
    current = result.chapter;
    console.log(`\n${titles.get(current)}`);
  }
  const detail = result.status === 'pass' ? `${(result.durationMs / 1000).toFixed(1)}s` : (result.reason ?? '');
  console.log(`  ${mark[result.status]} ${result.name}  ${detail}`);
  if (result.status === 'fail' && result.output) {
    const tail = result.output.trimEnd().split(/\r?\n/).slice(-15);
    console.log(tail.map((line) => `      ${line}`).join('\n'));
  }
};

const root = fileURLToPath(new URL('../..', import.meta.url));
const results = await runChecks(chapters, { cwd: root, baseEnv, onResult: print });
const counts = summarize(results);

console.log('\n按章节：');
for (const chapter of chapters) {
  const own = results.filter((result) => result.chapter === chapter.id);
  const status = own.some((r) => r.status === 'fail') ? 'fail' : own.every((r) => r.status === 'skip') ? 'skip' : 'pass';
  console.log(`  ${mark[status]} ${chapter.id.padEnd(18)}${chapter.title}`);
}
console.log(`\n通过 ${counts.pass}　失败 ${counts.fail}　跳过 ${counts.skip}`);
console.log(counts.fail === 0 ? '结论：✅ 验收通过' : '结论：❌ 有检查未通过，按上面的输出修复后重跑');

if (jsonPath) {
  const report = {
    finishedAt: new Date().toISOString(),
    node: process.version,
    counts,
    results: results.map(({ output: _output, ...rest }) => rest),
  };
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`报告已写入 ${jsonPath}`);
}
process.exit(counts.fail === 0 ? 0 : 1);
