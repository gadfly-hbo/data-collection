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

from core.providers.base import (ExtractionResult, TransientProviderError,
                                 UsageReportedError, normalize_provider_error)
from core.providers.json_text import extract_json_object, strip_code_fence

T = TypeVar("T", bound=BaseModel)


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
            item = schema.model_validate_json(extract_json_object(strip_code_fence(text)))
        except ValueError as e:
            # 校验失败但调用已发生：用量必须带回台账（预算口径）
            raise UsageReportedError(
                f"响应不是合法的 {schema.__name__}，原始内容片段：{text[:200]}",
                resp.usage.input_tokens or 0, resp.usage.output_tokens or 0) from e
        return ExtractionResult(
            item=item,
            input_tokens=resp.usage.input_tokens or 0,
            output_tokens=resp.usage.output_tokens or 0,
            provider=self.name,
            model=self.model,
        )
