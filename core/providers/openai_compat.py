"""OpenAI 协议兼容 Provider：OpenAI 官方 / DeepSeek / OpenRouter / Ollama 等。

response_format 三档适配端点差异：
- json_schema（默认）：strict 模式，服务端硬约束输出
- json_object：仅承诺合法 JSON（部分端点不支持 schema 模式）
- none：纯 Prompt 约束（最兼容），由 Pydantic 强校验兜底
"""
from __future__ import annotations

import json
import os
from typing import TypeVar

from openai import AsyncOpenAI
from pydantic import BaseModel

from core.providers.base import (ExtractionResult, TransientProviderError,
                                 UsageReportedError, normalize_provider_error)
from core.providers.json_text import extract_json_object, strip_code_fence

T = TypeVar("T", bound=BaseModel)

_DEFAULT_SYSTEM = "你是信息提取助手。只输出一个符合要求的 JSON 对象，禁止解释文字。"


def _strictify(schema: dict) -> dict:
    """OpenAI strict 模式硬性要求：每层对象 additionalProperties:false 且
    所有属性入 required（LLM 必须给出全部字段，含可选字段——缺失即 400）。
    直接就地修整 model_json_schema() 的输出并返回。"""
    def fix(node):
        if isinstance(node, dict):
            if "properties" in node:
                node["additionalProperties"] = False
                node["required"] = list(node["properties"].keys())
            for value in node.values():
                fix(value)
        elif isinstance(node, list):
            for value in node:
                fix(value)
        return node

    return fix(schema)


class OpenAICompatProvider:
    name = "openai-compat"

    def __init__(self, model: str, base_url: str | None = None,
                 api_key_env: str = "OPENAI_API_KEY",
                 response_format: str = "json_schema", client=None):
        if response_format not in ("json_schema", "json_object", "none"):
            raise ValueError(f"未知 response_format: {response_format!r}")
        if client is None:  # client 参数供测试注入替身
            key = os.environ.get(api_key_env)
            if not key:
                raise RuntimeError(f"缺少 {api_key_env} 环境变量（可写入 .env）")
            client = AsyncOpenAI(base_url=base_url, api_key=key)
        self.client = client
        self.model = model
        self.response_format = response_format

    def _response_format(self, schema: type[BaseModel]) -> dict | None:
        if self.response_format == "json_schema":
            return {"type": "json_schema",
                    "json_schema": {"name": schema.__name__,
                                    "schema": _strictify(schema.model_json_schema()),
                                    "strict": True}}
        if self.response_format == "json_object":
            return {"type": "json_object"}
        return None

    async def extract(self, content: str, schema, *, instruction: str = ""):
        schema_json = json.dumps(schema.model_json_schema(), ensure_ascii=False, indent=2)
        system = (instruction or _DEFAULT_SYSTEM).strip() + (
            "\n\n只输出一个符合以下 JSON Schema 的 JSON 对象，"
            "禁止 Markdown 代码块标记、注释或解释文字：\n" + schema_json)
        kwargs: dict = {"model": self.model,
                        "messages": [{"role": "system", "content": system},
                                     {"role": "user", "content": content}]}
        response_format = self._response_format(schema)
        if response_format is not None:
            kwargs["response_format"] = response_format

        try:
            resp = await self.client.chat.completions.create(**kwargs)
        except TransientProviderError:
            raise
        except Exception as e:
            raise normalize_provider_error(e) from e

        text = (resp.choices[0].message.content or "").strip()
        if not text:
            raise RuntimeError("供应商返回空响应")
        usage = resp.usage
        try:
            item = schema.model_validate_json(extract_json_object(strip_code_fence(text)))
        except ValueError as e:
            # 校验失败但调用已发生：用量必须带回台账（预算口径）
            raise UsageReportedError(
                f"响应不是合法的 {schema.__name__}，原始内容片段：{text[:200]}",
                getattr(usage, "prompt_tokens", 0) or 0,
                getattr(usage, "completion_tokens", 0) or 0) from e
        return ExtractionResult(
            item=item,
            input_tokens=getattr(usage, "prompt_tokens", 0) or 0,
            output_tokens=getattr(usage, "completion_tokens", 0) or 0,
            provider=self.name, model=self.model,
        )
