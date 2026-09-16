"""按 settings.yaml 的 provider 配置组装生产用 Provider 栈。

新增供应商 = 在 core/providers/ 下新增实现类 + 在此注册一行。
栈结构：RateLimitedProvider( FallbackProvider( primary, fallback ) )——
令牌桶主动限速在最外，主供应商退避穷尽后自动切换备用；
台账经 ExtractionResult.provider 记录实际完成提取的供应商。
"""
from __future__ import annotations

import logging
from collections.abc import Callable

from core.providers.anthropic_compat import AnthropicCompatProvider
from core.providers.base import ExtractionResult, LLMProvider, TransientProviderError
from core.providers.gemini import GeminiProvider
from core.rate_limiter import RateLimitedProvider, with_backoff

logger = logging.getLogger(__name__)

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


class FallbackProvider:
    """主供应商瞬态错误退避穷尽后切换备用供应商（每次切换触发 on_degrade 回调）。"""

    def __init__(self, primary: LLMProvider, fallback: LLMProvider | None = None,
                 *, max_retries: int = 5,
                 on_degrade: Callable[[str, str], None] | None = None):
        self.primary = primary
        self.fallback = fallback
        self.max_retries = max_retries
        self._on_degrade = on_degrade
        self.name = primary.name if fallback is None else f"{primary.name}|{fallback.name}"

    async def extract(self, content: str, schema, *, instruction: str = ""):
        try:
            return await with_backoff(
                lambda: self.primary.extract(content, schema, instruction=instruction),
                max_retries=self.max_retries)
        except TransientProviderError as e:
            if self.fallback is None:
                raise
            logger.warning("主供应商 %s 退避穷尽（%s），切换备用供应商 %s",
                           self.primary.name, e, self.fallback.name)
            if self._on_degrade is not None:
                self._on_degrade(self.primary.name, self.fallback.name)
            return await with_backoff(
                lambda: self.fallback.extract(content, schema, instruction=instruction),
                max_retries=self.max_retries)


def create_provider_stack(provider_cfg: dict) -> LLMProvider:
    """按 primary → fallback 顺序取可用者组装栈；全部缺 Key 抛 RuntimeError。

    备用供应商缺 Key 不阻塞主通道（仅少一层降级保障）。
    """
    problems: list[str] = []
    built: list[tuple[str, LLMProvider]] = []
    for name in (provider_cfg.get("primary"), provider_cfg.get("fallback")):
        if not name:
            continue
        try:
            built.append((name, create_provider(name, provider_cfg.get(name) or {})))
        except (RuntimeError, ValueError) as e:
            problems.append(f"{name}: {e}")
    if not built:
        raise RuntimeError(
            "无可用 LLM 供应商（请在 .env / 环境变量配置对应 Key）：\n  "
            + "\n  ".join(problems)
        )

    effective_name, effective = built[0]
    inner = FallbackProvider(effective, built[1][1]) if len(built) > 1 else effective
    rpm = (provider_cfg.get(effective_name) or {}).get("rpm")
    return RateLimitedProvider(inner, rpm)
