import { createMockModel } from '../llm/mock.ts';
import type { ChatModel } from '../llm/types.ts';

// 第 25 章：两个“假装训练过”的离线模型，只用来演示前后对比评测怎么发现改进和退化。
// 它们不会学习：行为差异是手写的规则，模仿两类真实存在的现象——
//   base：基座模型不守格式，回答时丢掉 [sourceId] 引用（微调最擅长修的就是这类问题）；
//   tuned：训练数据里拒答样本太少（被踩的拒答都被过滤掉了），模型学会了“不知道也硬答”。
export type ModelVariant = 'base' | 'tuned';

const REFUSAL = /没有找到你有权限查看的相关制度，无法给出确定答案。建议咨询人事或提交工单。/;

export function createMockVariant(variant: ModelVariant): ChatModel {
  const inner = createMockModel();
  return {
    name: `mock-${variant}`,
    async complete(request) {
      const response = await inner.complete({ ...request, onText: undefined });
      const { message } = response;
      if (!message.toolCalls?.length) {
        message.content = variant === 'base'
          ? message.content.replace(/\s*\[[\w-]+@v\d+\]/g, '')
          : message.content.replace(REFUSAL, '这类事项公司一般都有统一规定，按部门惯例办理即可。');
        request.onText?.(message.content);
      }
      return response;
    },
  };
}
