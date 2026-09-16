"""T3.1：限流退避验收测试（mock sleep / 注入时钟，不打真实 API）。"""
import pytest

from core.providers.base import ExtractionResult, TransientProviderError
from core.rate_limiter import (RateLimitedProvider, TokenBucketLimiter,
                               with_backoff)
from models.news_schema import NewsItem


def _result():
    item = NewsItem.model_validate({"title": "t", "summary": "s", "topics": ["x"],
                                    "sentiment": "neutral"})
    return ExtractionResult(item=item, input_tokens=1, output_tokens=1,
                            provider="fake", model="m")


class _Sleeper:
    """记录退避请求并立即放行（不做真实等待）。"""

    def __init__(self):
        self.waits: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)


async def test_backoff_intervals_double_each_retry():
    sleeper = _Sleeper()
    attempts = {"n": 0}

    async def flaky():
        attempts["n"] += 1
        if attempts["n"] <= 5:
            raise TransientProviderError("429 quota")
        return _result()

    result = await with_backoff(flaky, sleep=sleeper, rng=lambda: 0.0)
    assert result.item.title == "t"
    assert attempts["n"] == 6                       # 首次 + 5 次重试
    assert [round(w) for w in sleeper.waits] == [2, 4, 8, 16, 32]


async def test_backoff_jitter_bounds_delay():
    sleeper = _Sleeper()

    async def always_fail():
        raise TransientProviderError("503 unavailable")

    with pytest.raises(TransientProviderError):
        await with_backoff(always_fail, sleep=sleeper, max_retries=1, rng=lambda: 1.0)
    # base 2s × (1 + 0.25×1) = 2.5s，抖动只增不减
    assert sleeper.waits[0] == pytest.approx(2.5)


async def test_backoff_exhaustion_raises():
    sleeper = _Sleeper()
    calls = {"n": 0}

    async def always_fail():
        calls["n"] += 1
        raise TransientProviderError("429")

    with pytest.raises(TransientProviderError):
        await with_backoff(always_fail, sleep=sleeper, max_retries=2, rng=lambda: 0.0)
    assert calls["n"] == 3  # 首次 + 2 次重试，穷尽后向上抛出
    assert [round(w) for w in sleeper.waits] == [2, 4]


async def test_non_transient_error_propagates_immediately():
    sleeper = _Sleeper()

    async def auth_fail():
        raise RuntimeError("API key not valid")

    with pytest.raises(RuntimeError, match="not valid"):
        await with_backoff(auth_fail, sleep=sleeper)
    assert sleeper.waits == []  # 不做任何退避


class _FakeClock:
    def __init__(self):
        self.t = 100.0

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


async def test_token_bucket_delays_beyond_rpm():
    clock = _FakeClock()
    waits: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        waits.append(seconds)
        clock.advance(seconds)

    # 6 RPM = 0.1 token/s，桶容量 1：第 2 个令牌需等 10 秒
    limiter = TokenBucketLimiter(6, burst=1, clock=clock, sleep=fake_sleep)
    await limiter.acquire()
    await limiter.acquire()
    await limiter.acquire()
    assert waits and waits[0] == pytest.approx(10.0)
    assert waits[1] == pytest.approx(10.0)  # 速率恒定，后续每枚同样等 10s


async def test_rate_limited_provider_acquires_before_extract():
    acquired: list[bool] = []

    class _Limiter:
        async def acquire(self) -> None:
            acquired.append(True)

    class _Inner:
        name = "inner"

        async def extract(self, content, schema, *, instruction=""):
            assert acquired == [True]  # 先限速、后调用
            return _result()

    provider = RateLimitedProvider(_Inner(), rpm=60)
    provider.limiter = _Limiter()
    result = await provider.extract("内容", NewsItem)
    assert result.provider == "fake"


def test_token_bucket_rejects_non_positive_rpm():
    with pytest.raises(ValueError):
        TokenBucketLimiter(0)
