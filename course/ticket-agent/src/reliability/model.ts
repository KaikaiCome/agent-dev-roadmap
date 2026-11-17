import { loadConfig, type Config } from '../config.ts';
import { createMockModel } from '../llm/mock.ts';
import { createOpenAICompatibleModel } from '../llm/openai.ts';
import type { ChatModel } from '../llm/types.ts';
import { createRecordingModel, createReplayModel, loadFixture, type RecordingModel, type ReplayModel } from './recorder.ts';
import { createStochasticModel, type StochasticModel } from './stochastic.ts';
import { createToolArgValidator, type ToolArgValidator } from './structured.ts';

// 第 24 章：按环境变量组装 pass^k 评测用的模型。全部不设时就是第 2 章的确定性 mock，行为和 npm run eval 一致。
//   STOCHASTIC=v1|v2   用带随机扰动的 mock（SEED 固定种子）
//   LLM_REPLAY=路径     从录音回放，不访问任何模型（优先级最高）
//   LLM_RECORD=路径     把真实请求/回复录下来（真实模型：MODEL_PROVIDER=openai）
//   VALIDATE_TOOLS=on  工具参数先按 schema 校验，不合法就让模型当场修正
export interface ReliabilityModel {
  model: ChatModel;
  label: string;
  stochastic?: StochasticModel;
  recorder?: RecordingModel;
  replay?: ReplayModel;
  validator?: ToolArgValidator;
}

export function createReliabilityModel(env: Record<string, string | undefined> = process.env, config: Config = loadConfig(env)): ReliabilityModel {
  const seed = Number(env.SEED ?? 1);
  const result: Partial<ReliabilityModel> = {};
  let model: ChatModel;
  if (env.LLM_REPLAY) {
    model = result.replay = createReplayModel(loadFixture(env.LLM_REPLAY));
    result.label = `${model.name}（回放 ${env.LLM_REPLAY}）`;
  } else {
    if (env.STOCHASTIC && env.STOCHASTIC !== 'off') {
      model = result.stochastic = createStochasticModel({ seed, profile: env.STOCHASTIC });
      result.label = `${model.name}（离线随机扰动，种子 ${seed}）`;
    } else if (config.provider === 'mock') {
      model = createMockModel();
      result.label = 'mock（离线、确定性）';
    } else {
      model = createOpenAICompatibleModel({ baseURL: config.baseURL, apiKey: config.apiKey, model: config.model });
      result.label = config.model;
    }
    if (env.LLM_RECORD) {
      model = result.recorder = createRecordingModel(model, { secrets: [config.apiKey], note: `SEED=${seed} STOCHASTIC=${env.STOCHASTIC ?? 'off'}` });
      result.label += `，录制到 ${env.LLM_RECORD}`;
    }
  }
  if (env.VALIDATE_TOOLS === 'on') {
    model = result.validator = createToolArgValidator(model);
    result.label += '，工具参数校验+修复';
  }
  return { ...result, model, label: result.label! };
}
