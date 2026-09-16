"""按 settings.yaml 的 provider 配置构造 LLMProvider 实例。

新增供应商 = 在 core/providers/ 下新增实现类 + 在此注册一行。
"""
from __future__ import annotations

from core.providers.anthropic_compat import AnthropicCompatProvider
from core.providers.base import LLMProvider
from core.providers.gemini import GeminiProvider

DEFAULT_MODELS = {
    "gemini": "gemini-flash-latest",
}


def create_provider(name: str, opts: dict | None = None) -> LLMProvider:
    opts = opts or {}
    if name == "gemini":
        return GeminiProvider(model=opts.get("model", DEFAULT_MODELS["gemini"]))
    if name == "anthropic-compat":
        return AnthropicCompatProvider(
            model=opts["model"],
            base_url=opts.get("base_url"),
            api_key_env=opts.get("api_key_env", "ANTHROPIC_API_KEY"),
            max_tokens=opts.get("max_tokens", 16384),
        )
    # openai-compat 按 TASKS T4.2 在 Phase 4 实现
    raise ValueError(f"未知 provider: {name!r}")
