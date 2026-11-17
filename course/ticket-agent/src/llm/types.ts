// 项目内部统一的消息格式。不同模型服务商的格式在适配器里转换，
// 业务代码只认这里的类型，换服务商时不用改 Agent 逻辑。

export interface ToolCall {
  id: string;
  name: string;
  /** 模型生成的原始 JSON 字符串，执行前必须解析和校验 */
  arguments: string;
}

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export type AssistantMessage = Extract<Message, { role: 'assistant' }>;

/** 交给模型看的工具说明：名称、用途、参数的 JSON Schema */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** true = 服务商没有返回用量，这是按字符数做的保守估算 */
  estimated?: boolean;
}

export interface ModelRequest {
  messages: Message[];
  tools?: ToolSpec[];
  /** 本次调用最多生成多少 token，用于控制成本 */
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** 每收到一小段文字就回调一次，用来做打字机效果 */
  onText?: (delta: string) => void;
  /** 第 24 章：要求模型按 JSON Schema 输出最终回答（OpenAI 兼容服务映射为 response_format: json_schema） */
  responseFormat?: { name: string; schema: Record<string, unknown>; strict?: boolean };
}

export interface ModelResponse {
  message: AssistantMessage;
  usage: Usage;
  /** stop = 正常结束；tool_calls = 要调用工具；length = 被长度截断 */
  finishReason: string;
  /** 实际给出回复的模型。经过降级链时和 ChatModel.name 不同，成本统计以它为准 */
  model?: string;
}

export interface ChatModel {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
