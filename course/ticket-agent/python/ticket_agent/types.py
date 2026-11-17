from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

# 对应 src/llm/types.ts。TS 用联合类型，这里用 dataclass；运行时不做校验，
# 校验只发生在“不可信输入”进入系统的地方（模型给的工具参数、HTTP 响应）。


def dumps(value: Any) -> str:
    """与 JSON.stringify 一致：不转义中文、不加空格。

    json.dumps 默认 ensure_ascii=True 会把中文写成 \\uXXXX：字符数变多（token 估算偏大），
    还会让“回答里不能出现某段中文”这类字符串检查永远通过。
    """
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    # 模型生成的原始 JSON 字符串，执行前必须解析和校验
    arguments: str

    def to_json(self) -> dict[str, str]:
        return {'id': self.id, 'name': self.name, 'arguments': self.arguments}

    @staticmethod
    def from_json(data: dict[str, Any]) -> ToolCall:
        return ToolCall(data['id'], data['name'], data['arguments'])


@dataclass(frozen=True)
class Message:
    role: str  # system | user | assistant | tool
    content: str
    tool_calls: tuple[ToolCall, ...] = ()
    tool_call_id: str | None = None


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int
    # True = 服务商没有返回用量，这是按字符数做的保守估算
    estimated: bool = False


@dataclass(frozen=True)
class ModelResponse:
    message: Message
    usage: Usage
    # stop = 正常结束；tool_calls = 要调用工具；length = 被长度截断
    finish_reason: str
    model: str | None = None


@dataclass
class ModelRequest:
    messages: list[Message]
    tools: list[dict[str, Any]] = field(default_factory=list)
    max_output_tokens: int | None = None
    # 没有 signal 参数：asyncio 的取消由 Task.cancel() 在 await 点注入，不需要层层传递
    on_text: Callable[[str], None] | None = None


class ChatModel(Protocol):
    name: str

    async def complete(self, request: ModelRequest) -> ModelResponse: ...
