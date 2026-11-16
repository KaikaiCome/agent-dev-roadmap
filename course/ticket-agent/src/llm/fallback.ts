import { ModelError } from './openai.ts';
import type { ChatModel, ModelResponse } from './types.ts';

export interface FallbackOptions {
  /** 连续失败几次后熔断 */
  failureThreshold?: number;
  /** 熔断多久后放一个请求试探（半开） */
  cooldownMs?: number;
  now?: () => number;
}

export interface ModelHealth {
  name: string;
  failures: number;
  open: boolean;
}

/**
 * 按顺序尝试多个模型：前一个出现服务端故障就换下一个。
 * 连续失败的模型会被熔断一段时间，期间直接跳过，不再让每个请求都先等它超时。
 * 单个模型内部的重试由适配器负责（见 openai.ts），这里只处理“换模型”。
 */
export function createFallbackModel(models: ChatModel[], options: FallbackOptions = {}): ChatModel & { health(): ModelHealth[] } {
  if (models.length === 0) throw new Error('至少需要一个模型');
  const { failureThreshold = 3, cooldownMs = 30_000, now = Date.now } = options;
  const state = models.map(() => ({ failures: 0, openUntil: 0, probing: false }));

  return {
    name: models.map((model) => model.name).join(' → '),
    health: () => models.map((model, i) => ({ name: model.name, failures: state[i].failures, open: state[i].openUntil > now() })),
    async complete(request): Promise<ModelResponse> {
      let lastError: unknown;
      for (const [i, model] of models.entries()) {
        const breaker = state[i];
        if (breaker.openUntil > now()) continue;
        // 半开：冷却结束后只放一个试探请求，其他请求继续走备用模型，避免恢复瞬间涌入
        const halfOpen = breaker.failures >= failureThreshold;
        if (halfOpen && breaker.probing) continue;
        if (halfOpen) breaker.probing = true;
        let emitted = false;
        try {
          const response = await model.complete({
            ...request,
            onText: (delta) => {
              emitted = true;
              request.onText?.(delta);
            },
          });
          breaker.failures = 0;
          breaker.openUntil = 0;
          return { ...response, model: response.model ?? model.name };
        } catch (error) {
          if (request.signal?.aborted) throw error;
          // 400、401 这类是请求本身的问题，换模型也没用，还会掩盖 bug
          if (error instanceof ModelError && !error.retryable) throw error;
          breaker.failures += 1;
          if (breaker.failures >= failureThreshold) breaker.openUntil = now() + cooldownMs;
          // 用户已经看到了一部分回答，换模型会拼出两段不相干的文字
          if (emitted) throw error;
          lastError = error;
        } finally {
          if (halfOpen) breaker.probing = false;
        }
      }
      throw lastError ?? new ModelError('所有模型都处于熔断状态', 503, true);
    },
  };
}
