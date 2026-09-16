"""T1.6：流水线主干验收测试（MockTransport 页面 + FakeProvider，不打真实 API）。"""
import pathlib

import httpx
import pytest

from core.fetcher import Fetcher
from core.pipeline import Pipeline, RunStatus, TaskSpec
from core.providers.base import ExtractionResult, TransientProviderError
from models.news_schema import NewsItem

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTICLE_HTML = (REPO_ROOT / "tests" / "fixtures" / "article.html").read_text()
LINK_LIST_HTML = (REPO_ROOT / "tests" / "fixtures" / "link_list.html").read_text()


class FakeProvider:
    name = "fake"

    def __init__(self, results):
        """results：每次调用的返回（ExtractionResult 或异常），超出后复用最后一个。"""
        self.results = list(results)
        self.calls: list[dict] = []

    async def extract(self, content, schema, *, instruction=""):
        self.calls.append({"content": content, "instruction": instruction})
        result = self.results[min(len(self.calls) - 1, len(self.results) - 1)]
        if isinstance(result, Exception):
            raise result
        return result


def _result(**item_overrides) -> ExtractionResult:
    item = NewsItem.model_validate({
        "title": "测试标题", "summary": "测试摘要",
        "topics": ["测试"], "sentiment": "neutral", **item_overrides,
    })
    return ExtractionResult(item=item, input_tokens=11, output_tokens=7,
                            provider="fake", model="fake-model")


def _fetcher_for_page(html: str = ARTICLE_HTML, robots=404, page_status=200) -> Fetcher:
    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            if isinstance(robots, int):
                return httpx.Response(robots)
            return httpx.Response(200, text=robots)
        if request.headers.get("if-none-match") == '"v1"':
            return httpx.Response(304)
        return httpx.Response(page_status, text=html, headers={"ETag": '"v1"'})

    return Fetcher("TestBot/1.0", min_interval_per_host_s=0,
                   transport=httpx.MockTransport(handle))


async def test_success_path():
    provider = FakeProvider([_result()])
    async with _fetcher_for_page() as f:
        outcome = await Pipeline(f, provider).run(
            TaskSpec(url="https://a.example/news/1", schema=NewsItem))

    assert outcome.status is RunStatus.SUCCESS
    assert outcome.item.source_url == "https://a.example/news/1"  # 系统覆盖追溯字段
    assert outcome.item.scraped_at.tzinfo is not None
    assert (outcome.input_tokens, outcome.output_tokens) == (11, 7)
    assert (outcome.provider, outcome.model) == ("fake", "fake-model")
    assert outcome.duration_ms >= 0
    assert outcome.ok
    assert len(provider.calls) == 1


async def test_blocked_short_circuits_before_llm():
    provider = FakeProvider([_result()])
    async with _fetcher_for_page(robots="User-agent: *\nDisallow: /\n") as f:
        outcome = await Pipeline(f, provider).run(
            TaskSpec(url="https://a.example/1", schema=NewsItem))

    assert outcome.status is RunStatus.BLOCKED
    assert provider.calls == []  # 过闸门失败不得消耗 LLM 调用


async def test_fetch_error_short_circuits_before_llm():
    provider = FakeProvider([_result()])
    async with _fetcher_for_page(page_status=500) as f:
        outcome = await Pipeline(f, provider).run(
            TaskSpec(url="https://a.example/1", schema=NewsItem))

    assert outcome.status is RunStatus.FETCH_ERROR
    assert provider.calls == []


async def test_no_content_page_skipped_before_llm():
    provider = FakeProvider([_result()])
    async with _fetcher_for_page(html=LINK_LIST_HTML) as f:
        outcome = await Pipeline(f, provider).run(
            TaskSpec(url="https://a.example/list", schema=NewsItem))

    assert outcome.status is RunStatus.SKIPPED_NO_CONTENT
    assert provider.calls == []


async def test_validation_failure_retries_once_with_hint():
    provider = FakeProvider([ValueError("响应不是合法的 NewsItem，片段：xxx"), _result()])
    async with _fetcher_for_page() as f:
        outcome = await Pipeline(f, provider).run(
            TaskSpec(url="https://a.example/1", schema=NewsItem, instruction="提取"))

    assert outcome.status is RunStatus.SUCCESS
    assert len(provider.calls) == 2
    assert "未通过" in provider.calls[1]["instruction"]
    assert "Schema" in provider.calls[1]["instruction"]
    assert provider.calls[1]["instruction"] != provider.calls[0]["instruction"]


async def test_two_validation_failures_yield_schema_error():
    provider = FakeProvider([ValueError("bad json")])  # 永远失败（复用最后一个）
    async with _fetcher_for_page() as f:
        outcome = await Pipeline(f, provider).run(
            TaskSpec(url="https://a.example/1", schema=NewsItem))

    assert outcome.status is RunStatus.SCHEMA_ERROR
    assert "两次" in outcome.error
    assert len(provider.calls) == 2  # 恰好一次纠错重试


async def test_not_modified_maps_to_skipped_unchanged():
    provider = FakeProvider([_result()])
    async with _fetcher_for_page() as f:
        pipeline = Pipeline(f, provider)
        first = await pipeline.run(TaskSpec(url="https://a.example/1", schema=NewsItem))
        second = await pipeline.run(TaskSpec(url="https://a.example/1", schema=NewsItem))

    assert first.status is RunStatus.SUCCESS
    assert second.status is RunStatus.SKIPPED_UNCHANGED
    assert len(provider.calls) == 1  # 内容未变：0 次重复 LLM 调用


async def test_transient_provider_error_propagates():
    provider = FakeProvider([TransientProviderError("429 quota exceeded")])
    async with _fetcher_for_page() as f:
        with pytest.raises(TransientProviderError):
            await Pipeline(f, provider).run(
                TaskSpec(url="https://a.example/1", schema=NewsItem))


# ---------- T2.3：快照 + 去重闸门集成 ----------

def _wired_pipeline(provider, tmp_path, html_by_call: list[str]):
    """构造接通快照与去重的 Pipeline；html_by_call 依次给出每次页面请求的返回内容。"""
    served = {"i": 0}

    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            return httpx.Response(404)
        html = html_by_call[min(served["i"], len(html_by_call) - 1)]
        served["i"] += 1
        return httpx.Response(200, text=html)

    from core.dedup import DedupGate
    from storage.db import Database
    from storage.raw_store import RawStore

    fetcher = Fetcher("TestBot/1.0", min_interval_per_host_s=0,
                      transport=httpx.MockTransport(handle))
    db = Database(":memory:")
    return Pipeline(fetcher, provider, raw_store=RawStore(tmp_path / "raw"),
                    dedup=DedupGate(db)), db


async def test_second_identical_run_skips_with_zero_llm_calls(tmp_path):
    provider = FakeProvider([_result()])
    pipeline, _ = _wired_pipeline(provider, tmp_path, [ARTICLE_HTML])
    task = TaskSpec(url="https://a.example/story", schema=NewsItem)

    first = await pipeline.run(task)
    second = await pipeline.run(task)

    assert first.status is RunStatus.SUCCESS
    assert first.raw_hash
    assert second.status is RunStatus.SKIPPED_UNCHANGED
    assert second.raw_hash == first.raw_hash
    assert len(provider.calls) == 1  # 重复执行：0 次重复 LLM 调用


async def test_same_url_new_content_re_extracts(tmp_path):
    provider = FakeProvider([_result()])
    pipeline, _ = _wired_pipeline(provider, tmp_path,
                                  [ARTICLE_HTML, ARTICLE_HTML + "<p>新增段落，内容有更新</p>"])
    task = TaskSpec(url="https://a.example/story", schema=NewsItem)

    first = await pipeline.run(task)
    second = await pipeline.run(task)

    assert first.status is RunStatus.SUCCESS
    assert second.status is RunStatus.SUCCESS  # 内容有更新 → 不命中去重，重新提取
    assert second.raw_hash != first.raw_hash
    assert len(provider.calls) == 2


async def test_same_content_different_urls_both_extract(tmp_path):
    provider = FakeProvider([_result()])
    pipeline, _ = _wired_pipeline(provider, tmp_path, [ARTICLE_HTML])
    first = await pipeline.run(TaskSpec(url="https://a.example/story", schema=NewsItem))
    second = await pipeline.run(TaskSpec(url="https://b.example/mirror", schema=NewsItem))

    assert first.status is RunStatus.SUCCESS
    assert second.status is RunStatus.SUCCESS  # 不同 URL 的同内容互不干扰
    assert len(provider.calls) == 2

