"""限流退避：429/5xx 指数退避 + 抖动；按 RPM 的令牌桶主动限速。

TransientProviderError 由 Provider 层归一化产生（core/providers/base.py）。
"""
from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable

from core.providers.base import LLMProvider, TransientProviderError

_DEFAULT_MAX_RETRIES = 5
_DEFAULT_BASE_DELAY = 2.0
_DEFAULT_CAP = 300.0
_DEFAULT_JITTER = 0.25


async def with_backoff(
    fn: Callable[[], Awaitable],
    *,
    max_retries: int = _DEFAULT_MAX_RETRIES,
    base_delay: float = _DEFAULT_BASE_DELAY,
    cap: float = _DEFAULT_CAP,
    jitter: float = _DEFAULT_JITTER,
    rng: Callable[[], float] = random.random,
    sleep: Callable[[float], Awaitable] = asyncio.sleep,
):
    """执行 fn()；TransientProviderError 按 2s→4s→8s→16s→32s（封顶 cap）退避重试。

    重试穷尽后向上抛出最后一次异常；非瞬态错误（鉴权、参数等）立即传播。
    """
    attempt = 0
    while True:
        try:
            return await fn()
        except TransientProviderError:
            if attempt >= max_retries:
                raise
            delay = min(cap, base_delay * (2 ** attempt)) * (1.0 + jitter * rng())
            await sleep(delay)
            attempt += 1


class TokenBucketLimiter:
    """令牌桶：超过 RPM 速率的调用等待而非发出（主动限速，从源头避免 429）。"""

    def __init__(self, rpm: float, burst: float | None = None, *,
                 clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], Awaitable] = asyncio.sleep):
        if rpm <= 0:
            raise ValueError("rpm 必须为正数")
        self.rate = rpm / 60.0                     # tokens / second
        self.capacity = burst if burst is not None else max(1.0, rpm / 2)
        self._tokens = self.capacity
        self._updated = clock()
        self._clock = clock
        self._sleep = sleep

    async def acquire(self) -> None:
        while True:
            now = self._clock()
            self._tokens = min(self.capacity,
                               self._tokens + (now - self._updated) * self.rate)
            self._updated = now
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return
            await self._sleep((1.0 - self._tokens) / self.rate)


class RateLimitedProvider:
    """LLMProvider 装饰器：提取调用前先过令牌桶（rpm 为 None 时不限速）。"""

    def __init__(self, inner: LLMProvider, rpm: float | None = None):
        self.inner = inner
        self.name = inner.name
        self.limiter = TokenBucketLimiter(rpm) if rpm else None

    async def extract(self, content: str, schema, *, instruction: str = ""):
        if self.limiter is not None:
            await self.limiter.acquire()
        return await self.inner.extract(content, schema, instruction=instruction)
