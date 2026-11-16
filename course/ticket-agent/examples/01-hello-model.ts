// 第 1 章：第一次调用模型，并以流式方式逐字打印。
// 运行：npm run hello -- "用一句话解释什么是 AI Agent"
import { loadConfig } from '../src/config.ts';
import { createModel } from '../src/llm/index.ts';

const config = loadConfig();
const model = createModel(config);
const question = process.argv[2] ?? '用一句话解释什么是 AI Agent';

console.log(`模型：${model.name}`);
const started = Date.now();
const response = await model.complete({
  messages: [
    { role: 'system', content: '你是企业内部助手，回答简洁准确。' },
    { role: 'user', content: question },
  ],
  onText: (delta) => process.stdout.write(delta),
});

console.log(`\n\n结束原因：${response.finishReason}`);
console.log(`用量：输入 ${response.usage.inputTokens} token，输出 ${response.usage.outputTokens} token，耗时 ${Date.now() - started} ms`);
