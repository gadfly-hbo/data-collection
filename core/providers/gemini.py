"""Gemini API Provider（默认）：原生 Structured Output，凭据取 GEMINI_API_KEY。"""
from __future__ import annotations

import os
from typing import TypeVar

from google import genai
from google.genai import types
from pydantic import BaseModel, ValidationError

from core.providers.base import (ExtractionResult, TransientProviderError,
                                 UsageReportedError, normalize_provider_error)

T = TypeVar("T", bound=BaseModel)


class GeminiProvider:
    name = "gemini"

    def __init__(self, model: str = "gemini-flash-latest", client=None) -> None:
        # 模型名以官方文档当前稳定版为准；client 参数供测试注入替身
        if client is None:
            if not os.environ.get("GEMINI_API_KEY"):
                raise RuntimeError("缺少 GEMINI_API_KEY 环境变量（可写入 .env）")
            client = genai.Client()
        self.client = client
        self.model = model

    async def extract(
        self, content: str, schema: type[T], *, instruction: str = ""
    ) -> ExtractionResult[T]:
        prompt = f"{instruction}\n\n{content}" if instruction else content
        try:
            resp = await self.client.aio.models.generate_content(
                model=self.model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=schema,  # SDK 接受 Pydantic 模型，服务端硬约束输出
                ),
            )
        except TransientProviderError:
            raise
        except Exception as e:
            raise normalize_provider_error(e) from e

        if not resp.text:
            candidates = getattr(resp, "candidates", None)
            finish = getattr(candidates[0], "finish_reason", None) if candidates else None
            raise RuntimeError(f"Gemini 返回空响应（finish_reason={finish}）")
        usage = resp.usage_metadata
        input_tokens = getattr(usage, "prompt_token_count", 0) or 0
        output_tokens = getattr(usage, "candidates_token_count", 0) or 0
        try:
            item = schema.model_validate_json(resp.text)
        except ValidationError as e:
            # 校验失败但调用已发生：用量必须带回台账（预算口径）
            raise UsageReportedError(
                f"响应不是合法的 {schema.__name__}，原始内容片段：{resp.text[:200]}",
                input_tokens, output_tokens) from e
        return ExtractionResult(
            item=item,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            provider=self.name,
            model=self.model,
        )
