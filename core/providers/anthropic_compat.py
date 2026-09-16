"""Anthropic 协议兼容 Provider：覆盖 Anthropic 官方 API 与 MiniMax 等兼容端点。

Anthropic Messages API 无服务端 json_schema 约束，Schema 以 Prompt 注入 +
Pydantic 强校验兜底；思考型模型（如 MiniMax-M3）的思考内容不在 text 块中。
"""
from __future__ import annotations

import json
import os
from typing import TypeVar

from anthropic import AsyncAnthropic
from pydantic import BaseModel

from core.providers.base import ExtractionResult, TransientProviderError, normalize_provider_error

T = TypeVar("T", bound=BaseModel)


def _strip_code_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        first_line_break = text.find("\n")
        if first_line_break != -1:  # 掉落 ```json 等语言标记行
            text = text[first_line_break + 1:]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    return text.strip()


def _extract_json_object(text: str) -> str:
    """从文本中提取第一个完整的最外层 JSON 对象（感知字符串内的花括号）。

    兼容模型在 JSON 前后偶发附加说明文字的情况。
    """
    start = text.find("{")
    if start == -1:
        return text
    depth, in_string, escape = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return text[start:]


class AnthropicCompatProvider:
    name = "anthropic-compat"

    def __init__(
        self,
        model: str,
        base_url: str | None = None,
        api_key_env: str = "ANTHROPIC_API_KEY",
        max_tokens: int = 16384,  # 思考型模型会消耗输出 token，需留余量
        client=None,
    ) -> None:
        # client 参数供测试注入替身
        if client is None:
            key = os.environ.get(api_key_env)
            if not key:
                raise RuntimeError(f"缺少 {api_key_env} 环境变量（可写入 .env）")
            client = AsyncAnthropic(base_url=base_url, api_key=key)
        self.client = client
        self.model = model
        self.max_tokens = max_tokens

    async def extract(
        self, content: str, schema: type[T], *, instruction: str = ""
    ) -> ExtractionResult[T]:
        schema_json = json.dumps(schema.model_json_schema(), ensure_ascii=False, indent=2)
        system = (instruction or "你是信息提取助手。").strip() + (
            "\n\n只输出一个符合以下 JSON Schema 的 JSON 对象，"
            "禁止输出 Markdown 代码块标记、注释或任何解释文字：\n" + schema_json
        )
        try:
            resp = await self.client.messages.create(
                model=self.model,
                max_tokens=self.max_tokens,
                system=system,
                messages=[{"role": "user", "content": content}],
            )
        except TransientProviderError:
            raise
        except Exception as e:
            raise normalize_provider_error(e) from e

        text = "".join(
            block.text for block in resp.content if getattr(block, "type", "") == "text"
        ).strip()
        if not text:
            raise RuntimeError(f"供应商返回空响应（stop_reason={resp.stop_reason}）")

        try:
            item = schema.model_validate_json(_extract_json_object(_strip_code_fence(text)))
        except ValueError as e:
            raise ValueError(
                f"响应不是合法的 {schema.__name__}，原始内容片段：{text[:200]}"
            ) from e
        return ExtractionResult(
            item=item,
            input_tokens=resp.usage.input_tokens or 0,
            output_tokens=resp.usage.output_tokens or 0,
            provider=self.name,
            model=self.model,
        )
