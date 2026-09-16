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


def resolve_provider(provider_cfg: dict) -> LLMProvider:
    """按 primary → fallback 顺序返回第一个可构造的 provider（缺 Key 自动跳过）。"""
    problems: list[str] = []
    for name in (provider_cfg.get("primary"), provider_cfg.get("fallback")):
        if not name:
            continue
        try:
            return create_provider(name, provider_cfg.get(name) or {})
        except (RuntimeError, ValueError) as e:
            problems.append(f"{name}: {e}")
    raise RuntimeError(
        "无可用 LLM 供应商（请在 .env / 环境变量配置对应 Key）：\n  "
        + "\n  ".join(problems)
    )
