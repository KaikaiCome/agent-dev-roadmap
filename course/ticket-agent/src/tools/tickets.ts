import type { Store } from '../store.ts';
import { asObject, optionalStringArray, requireString, ToolError, type Tool, type ToolContext } from './types.ts';

// 写操作拆成两步：prepare_ticket 只生成草稿（无副作用，可随便调），
// create_ticket 才真正提交，并且必须经过用户确认。草稿生成后不可修改，
// 所以用户确认的内容就是最终提交的内容。
export function ticketTools(store: Store): Tool[] {
  const prepare: Tool<{ title: string; description: string; sourceIds: string[] }> = {
    spec: {
      name: 'prepare_ticket',
      description: '为员工生成 IT/行政工单草稿，不会提交。员工需要人工处理（报修、申请等）时先调用它，再调用 create_ticket。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话标题，例如“VPN 无法连接”', maxLength: 80 },
          description: { type: 'string', description: '问题描述，包含员工提供的现象和已尝试的操作', maxLength: 2000 },
          sourceIds: { type: 'array', items: { type: 'string' }, description: '相关制度的 sourceId', maxItems: 5 },
        },
        required: ['title', 'description'],
        additionalProperties: false,
      },
    },
    parse(args) {
      const input = asObject(args);
      return {
        title: requireString(input, 'title', 80),
        description: requireString(input, 'description', 2000),
        sourceIds: optionalStringArray(input, 'sourceIds', 5),
      };
    },
    run(args, { user, runId }) {
      const draft = store.saveDraft({ runId, tenantId: user.tenantId, userId: user.id, ...args });
      return { draftId: draft.id, title: draft.title, description: draft.description };
    },
  };

  const create: Tool<{ draftId: string }> = {
    requiresApproval: true,
    spec: {
      name: 'create_ticket',
      description: '提交一份已生成的工单草稿。系统会先请员工确认，确认后才会创建。只有收到成功结果才能告诉员工工单已创建。',
      parameters: {
        type: 'object',
        properties: { draftId: { type: 'string', description: 'prepare_ticket 返回的 draftId' } },
        required: ['draftId'],
        additionalProperties: false,
      },
    },
    parse: (args) => ({ draftId: requireString(asObject(args), 'draftId', 64) }),
    describe(args, context) {
      const draft = ownDraft(store, args.draftId, context);
      return draft
        ? `提交工单「${draft.title}」\n${draft.description}`
        : `提交工单（草稿 ${args.draftId} 不存在或无权访问，确认后也会失败）`;
    },
    run(args, context) {
      const draft = ownDraft(store, args.draftId, context);
      if (!draft) throw new ToolError('DRAFT_NOT_FOUND', `草稿 ${args.draftId} 不存在或不属于当前员工`);
      // 幂等键 = 本次 run + 本次工具调用。崩溃恢复后重复执行，也只会得到同一张工单
      const { ticket, created } = store.createTicketOnce({
        idempotencyKey: `${context.runId}:${context.callId}`,
        tenantId: draft.tenantId,
        userId: draft.userId,
        draftId: draft.id,
        title: draft.title,
      });
      return { ticketId: ticket.id, status: 'open', duplicate: !created };
    },
  };

  return [prepare, create];
}

function ownDraft(store: Store, draftId: string, { user, runId }: ToolContext) {
  const draft = store.getDraft(draftId);
  // 只能提交自己在本次 run 中生成的草稿，防止模型被诱导去提交别人的数据
  if (!draft || draft.tenantId !== user.tenantId || draft.userId !== user.id || draft.runId !== runId) return undefined;
  return draft;
}
