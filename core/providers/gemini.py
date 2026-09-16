"""Gemini API Provider（默认）：原生 Structured Output，凭据取 GEMINI_API_KEY。"""
from __future__ import annotations

import os
from typing import TypeVar

from google import genai
from google.genai import types
from pydantic import BaseModel

from core.providers.base import ExtractionResult, TransientProviderError

T = TypeVar("T", bound=BaseModel)

# 小写匹配；命中即视为可退避重试的瞬态错误
_TRANSIENT_MARKERS = (
    "429", "resource_exhausted", "rate limit", "quota",
    "500", "502", "503", "504", "internal error", "unavailable", "deadline exceeded",
)


def _as_transient(err: Exception) -> Exception:
    """把 429 / 5xx 归一化为 TransientProviderError；鉴权、参数等错误原样返回。"""
    status = getattr(err, "code", None)
    if isinstance(status, int) and (status == 429 or status >= 500):
        return TransientProviderError(str(err))
    if any(marker in str(err).lower() for marker in _TRANSIENT_MARKERS):
        return TransientProviderError(str(err))
    return err


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
            raise _as_transient(e) from e

        if not resp.text:
            candidates = getattr(resp, "candidates", None)
            finish = getattr(candidates[0], "finish_reason", None) if candidates else None
            raise RuntimeError(f"Gemini 返回空响应（finish_reason={finish}）")
        usage = resp.usage_metadata
        return ExtractionResult(
            item=schema.model_validate_json(resp.text),
            input_tokens=getattr(usage, "prompt_token_count", 0) or 0,
            output_tokens=getattr(usage, "candidates_token_count", 0) or 0,
            provider=self.name,
            model=self.model,
        )
