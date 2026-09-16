"""T3.2：供应商降级验收测试（FakeProvider 替身，不打真实 API）。"""
import pathlib

import httpx
import pytest

from core.dedup import DedupGate
from core.pipeline import Pipeline, RunStatus, TaskSpec
from core.providers.base import ExtractionResult, TransientProviderError
from core.providers.factory import FallbackProvider, create_provider_stack
from models.news_schema import NewsItem
from storage.db import Database
from storage.ledger import RunLedger
from storage.raw_store import RawStore

ARTICLE_HTML = (pathlib.Path(__file__).parent / "fixtures" / "article.html").read_text()

class _NoSleep:
    async def __call__(self, seconds: float) -> None:
        pass



class _FakeProvider:
    def __init__(self, name: str, results: list):
        self.name = name
        self.results = list(results)
        self.calls = 0

    async def extract(self, content, schema, *, instruction=""):
        self.calls += 1
        result = self.results[min(self.calls - 1, len(self.results) - 1)]
        if isinstance(result, Exception):
            raise result
        return result


def _result(provider: str) -> ExtractionResult:
    item = NewsItem.model_validate({"title": "t", "summary": "s", "topics": ["x"],
                                    "sentiment": "neutral"})
    return ExtractionResult(item=item, input_tokens=5, output_tokens=2,
                            provider=provider, model="m")


async def test_primary_exhausts_then_fallback_completes():
    degraded: list[tuple[str, str]] = []
    primary = _FakeProvider("primary-fake", [TransientProviderError("429")])
    fallback = _FakeProvider("fallback-fake", [_result("fallback-fake")])
    stack = FallbackProvider(primary, fallback, max_retries=2,
                             on_degrade=lambda a, b: degraded.append((a, b)),
                             sleep=_NoSleep())

    result = await stack.extract("正文", NewsItem)

    assert result.provider == "fallback-fake"   # 台账将记录实际完成的供应商
    assert primary.calls == 3                    # 首次 + 2 次退避重试
    assert fallback.calls == 1
    assert degraded == [("primary-fake", "fallback-fake")]


async def test_both_exhaust_raise_transient():
    primary = _FakeProvider("p", [TransientProviderError("429")])
    fallback = _FakeProvider("f", [TransientProviderError("503")])
    stack = FallbackProvider(primary, fallback, max_retries=1, sleep=_NoSleep())

    with pytest.raises(TransientProviderError):
        await stack.extract("x", NewsItem)
    assert primary.calls == 2 and fallback.calls == 2


async def test_no_fallback_propagates_after_exhaustion():
    primary = _FakeProvider("p", [TransientProviderError("429")])
    stack = FallbackProvider(primary, None, max_retries=1, sleep=_NoSleep())

    with pytest.raises(TransientProviderError):
        await stack.extract("x", NewsItem)
    assert primary.calls == 2


async def test_degrade_visible_in_ledger(tmp_path):
    """集成：主供应商持续失败 → 任务由 fallback 完成且 crawl_runs 记录 fallback。"""
    db = Database(":memory:")
    primary = _FakeProvider("primary-fake", [TransientProviderError("429 quota")])
    fallback = _FakeProvider("fallback-fake", [_result("fallback-fake")])
    stack = FallbackProvider(primary, fallback, max_retries=1, sleep=_NoSleep())

    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            return httpx.Response(404)
        return httpx.Response(200, text=ARTICLE_HTML)

    from core.fetcher import Fetcher
    fetcher = Fetcher("TestBot/1.0", min_interval_per_host_s=0,
                      transport=httpx.MockTransport(handle))
    async with fetcher:
        pipeline = Pipeline(fetcher, stack, raw_store=RawStore(tmp_path / "raw"),
                            dedup=DedupGate(db), ledger=RunLedger(db))
        outcome = await pipeline.run(
            TaskSpec(url="https://a.example/story", schema=NewsItem))

    assert outcome.status is RunStatus.SUCCESS
    assert outcome.provider == "fallback-fake"
    row = db.conn.execute("SELECT provider FROM crawl_runs").fetchone()
    assert row["provider"] == "fallback-fake"


# ---------- create_provider_stack 组装 ----------

def test_stack_starts_on_fallback_when_primary_key_missing(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("MINIMAX_API_KEY", "k")
    cfg = {
        "primary": "gemini",
        "fallback": "anthropic-compat",
        "gemini": {"model": "gemini-flash-latest"},
        "anthropic-compat": {"model": "MiniMax-M3",
                             "base_url": "https://api.minimax.cn/anthropic",
                             "api_key_env": "MINIMAX_API_KEY", "rpm": 30},
    }
    stack = create_provider_stack(cfg)
    assert stack.name == "anthropic-compat"      # 直接以可用者为主
    assert stack.limiter is not None and stack.limiter.rate == pytest.approx(0.5)


def test_stack_wraps_fallback_when_both_available(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setenv("MINIMAX_API_KEY", "k")
    cfg = {
        "primary": "gemini",
        "fallback": "anthropic-compat",
        "gemini": {"model": "gemini-flash-latest", "rpm": 10},
        "anthropic-compat": {"model": "MiniMax-M3",
                             "base_url": "https://api.minimax.cn/anthropic",
                             "api_key_env": "MINIMAX_API_KEY"},
    }
    stack = create_provider_stack(cfg)
    assert isinstance(stack.inner, FallbackProvider)
    assert stack.inner.fallback is not None
    assert stack.limiter.rate == pytest.approx(10 / 60)  # RPM 按主供应商配置


def test_stack_all_missing_raises(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("MINIMAX_API_KEY", raising=False)
    cfg = {"primary": "gemini", "fallback": "anthropic-compat",
           "gemini": {}, "anthropic-compat": {"model": "m"}}
    with pytest.raises(RuntimeError, match="无可用 LLM 供应商"):
        create_provider_stack(cfg)
