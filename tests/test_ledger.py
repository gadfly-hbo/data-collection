"""T2.4：台账全量接入验收——六种终态各触发一次，crawl_runs 各有一行且字段完整。"""
import json

from core.dedup import DedupGate
from core.pipeline import Pipeline, RunStatus, TaskSpec
from models.news_schema import NewsItem
from storage.db import Database
from storage.ledger import RunLedger
from storage.raw_store import RawStore
from test_pipeline import (  # 复用测试替身与夹具
    ARTICLE_HTML, LINK_LIST_HTML, FakeProvider, _fetcher_for_page, _result,
)


def _wired(provider, tmp_path):
    db = Database(":memory:")
    pipeline = Pipeline(fetcher=_fetcher_for_page(ARTICLE_HTML), provider=provider,
                        raw_store=RawStore(tmp_path / "raw"),
                        dedup=DedupGate(db), ledger=RunLedger(db))
    return pipeline, db


async def test_all_six_statuses_recorded_once(tmp_path):
    db = Database(":memory:")
    ledger, raw_store, dedup = RunLedger(db), RawStore(tmp_path / "raw"), DedupGate(db)

    # 1) SUCCESS：正文页 + 正常供应商
    good = FakeProvider([_result()])
    async with _fetcher_for_page(ARTICLE_HTML) as f:
        await Pipeline(f, good, raw_store, dedup, ledger).run(
            TaskSpec(url="https://a.example/story", schema=NewsItem))
    # 2) SKIPPED_UNCHANGED：同 URL 复跑——case 1 已有 SUCCESS 记录，去重闸门命中
    async with _fetcher_for_page(ARTICLE_HTML) as f:
        await Pipeline(f, good, raw_store, dedup, ledger).run(
            TaskSpec(url="https://a.example/story", schema=NewsItem))
    # 3) SKIPPED_NO_CONTENT：无正文列表页
    async with _fetcher_for_page(LINK_LIST_HTML) as f:
        await Pipeline(f, good, raw_store, dedup, ledger).run(
            TaskSpec(url="https://a.example/list", schema=NewsItem))
    # 4) FETCH_ERROR：页面 500
    async with _fetcher_for_page(page_status=500) as f:
        await Pipeline(f, good, raw_store, dedup, ledger).run(
            TaskSpec(url="https://a.example/broken", schema=NewsItem))
    # 5) BLOCKED：robots 拒绝
    async with _fetcher_for_page(robots="User-agent: *\nDisallow: /\n") as f:
        await Pipeline(f, good, raw_store, dedup, ledger).run(
            TaskSpec(url="https://a.example/denied", schema=NewsItem))
    # 6) SCHEMA_ERROR：供应商两次输出均非法
    bad = FakeProvider([ValueError("响应不是合法的 NewsItem")])
    async with _fetcher_for_page(ARTICLE_HTML) as f:
        await Pipeline(f, bad, raw_store, dedup, ledger).run(
            TaskSpec(url="https://a.example/schema-fail", schema=NewsItem))

    rows = db.conn.execute("SELECT * FROM crawl_runs ORDER BY id").fetchall()
    statuses = [r["status"] for r in rows]
    assert sorted(statuses) == sorted(s.value for s in RunStatus), statuses

    succ = next(r for r in rows if r["status"] == "SUCCESS")
    assert succ["provider"] == "fake" and succ["model"] == "fake-model"
    assert succ["input_tokens"] == 11 and succ["output_tokens"] == 7
    assert succ["duration_ms"] >= 0 and succ["raw_hash"]

    schema_err = next(r for r in rows if r["status"] == "SCHEMA_ERROR")
    assert schema_err["error_msg"] and "两次" in schema_err["error_msg"]

    blocked = next(r for r in rows if r["status"] == "BLOCKED")
    assert blocked["input_tokens"] == 0 and blocked["provider"] is None

    items = db.conn.execute("SELECT * FROM extracted_items").fetchall()
    assert len(items) == 1  # 仅 SUCCESS 写 extracted_items
    assert items[0]["run_id"] == succ["id"]
    assert items[0]["dedup_hash"] and len(items[0]["dedup_hash"]) == 64
    assert json.loads(items[0]["content"])["title"] == "测试标题"
    assert items[0]["schema_type"] == "NewsItem"


async def test_item_dedup_ignores_reextracted_identical_content(tmp_path):
    # 共享 db+ledger；关闭去重闸门（dedup=None）强制两次真实提取
    db = Database(":memory:")
    ledger = RunLedger(db)

    for i in (1, 2):
        provider = FakeProvider([_result()])
        async with _fetcher_for_page(ARTICLE_HTML) as f:
            await Pipeline(f, provider, RawStore(tmp_path / f"raw{i}"),
                           None, ledger).run(
                TaskSpec(url="https://a.example/story", schema=NewsItem))

    runs = db.conn.execute("SELECT COUNT(*) AS c FROM crawl_runs").fetchone()["c"]
    assert runs == 2  # 两次运行台账各记一行
    items = db.conn.execute("SELECT * FROM extracted_items").fetchall()
    assert len(items) == 1  # 内容相同（易变字段不参与哈希）→ 第二条被忽略
