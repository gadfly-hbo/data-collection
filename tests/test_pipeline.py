"""T1.6：流水线主干验收测试（MockTransport 页面 + FakeProvider，不打真实 API）。"""
import pathlib

import httpx
import pytest

from core.dedup import DedupGate
from core.fetcher import Fetcher
from core.pipeline import Pipeline, RunStatus, TaskSpec
from core.providers.base import (ExtractionResult, TransientProviderError,
                                 UsageReportedError)
from models.news_schema import NewsItem
from storage.db import Database
from storage.ledger import RunLedger
from storage.raw_store import RawStore

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


async def test_provider_exception_becomes_fetch_error_with_ledger(tmp_path):
    """P1-1：供应商异常不得绕过台账——pipeline 兑换为 FETCH_ERROR 终态并记录。"""
    provider = FakeProvider([TransientProviderError("429 quota")])
    db = Database(":memory:")
    async with _fetcher_for_page() as f:
        outcome = await Pipeline(f, provider, ledger=RunLedger(db)).run(
            TaskSpec(url="https://a.example/1", schema=NewsItem))

    assert outcome.status is RunStatus.FETCH_ERROR
    assert "TransientProviderError" in outcome.error
    row = db.conn.execute("SELECT * FROM crawl_runs").fetchone()
    assert row["status"] == "FETCH_ERROR"
    assert "TransientProviderError" in row["error_msg"]


async def test_schema_error_carries_accumulated_token_usage(tmp_path):
    """P2-3：校验失败的实际 Token 消耗须随 SCHEMA_ERROR 入台账（预算口径）。"""
    provider = FakeProvider([UsageReportedError("bad", 50, 5),
                             UsageReportedError("still bad", 30, 4)])
    db = Database(":memory:")
    async with _fetcher_for_page() as f:
        outcome = await Pipeline(f, provider, raw_store=RawStore(tmp_path / "raw"),
                                 ledger=RunLedger(db)).run(
            TaskSpec(url="https://a.example/1", schema=NewsItem))

    assert outcome.status is RunStatus.SCHEMA_ERROR
    assert (outcome.input_tokens, outcome.output_tokens) == (80, 9)  # 两次累计
    row = db.conn.execute("SELECT * FROM crawl_runs").fetchone()
    assert row["input_tokens"] == 80


async def test_failed_task_not_pinned_by_304(tmp_path):
    """P1-2：提取失败后内容未变 → 下次必须全量重抓重试，不得被 304 短路。"""
    requests = {"page": 0}

    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            return httpx.Response(404)
        requests["page"] += 1
        if request.headers.get("if-none-match") == '"v1"':
            return httpx.Response(304)
        return httpx.Response(200, text=ARTICLE_HTML, headers={"ETag": '"v1"'})

    db = Database(":memory:")
    fetcher = Fetcher("TestBot/1.0", min_interval_per_host_s=0,
                      transport=httpx.MockTransport(handle))
    task = TaskSpec(url="https://a.example/story", schema=NewsItem)
    async with fetcher:
        bad = Pipeline(fetcher, FakeProvider([ValueError("bad json")]),
                       raw_store=RawStore(tmp_path / "raw"),
                       dedup=DedupGate(db), ledger=RunLedger(db))
        assert (await bad.run(task)).status is RunStatus.SCHEMA_ERROR
        assert requests["page"] == 1

        good = Pipeline(fetcher, FakeProvider([_result()]),
                        raw_store=RawStore(tmp_path / "raw"),
                        dedup=DedupGate(db), ledger=RunLedger(db))
        outcome = await good.run(task)
        assert outcome.status is RunStatus.SUCCESS   # 失败后全量重抓重试
        assert requests["page"] == 2                 # 未被 304 短路

        again = await good.run(task)
        assert again.status is RunStatus.SKIPPED_UNCHANGED  # 成功后 304 短路恢复
        assert requests["page"] == 3


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

    fetcher = Fetcher("TestBot/1.0", min_interval_per_host_s=0,
                      transport=httpx.MockTransport(handle))
    db = Database(":memory:")
    return Pipeline(fetcher, provider, raw_store=RawStore(tmp_path / "raw"),
                    dedup=DedupGate(db), ledger=RunLedger(db)), db


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
    # 更新段落必须位于正文内——文档尾部追加会被 trafilatura 正确忽略（内容未变）
    updated = ARTICLE_HTML.replace(
        "</article>", "<p>更新：研究团队补充了 256 比特的新实验数据。</p></article>")
    pipeline, _ = _wired_pipeline(provider, tmp_path, [ARTICLE_HTML, updated])
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

