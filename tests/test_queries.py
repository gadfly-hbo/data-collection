"""T5.1：只读分析查询测试。"""
import json

import pytest

from storage.db import Database
from storage.queries import (blocked_sources, connect_ro, daily_tokens,
                             list_sources_with_last_run, query_items,
                             status_summary)

NEWS_JSON = json.dumps({"title": "关键词命中测试", "summary": "s", "topics": ["t"],
                        "sentiment": "neutral"}, ensure_ascii=False)


def _seed_ro(tmp_path):
    path = tmp_path / "collector.db"
    db = Database(path)
    sid = db.upsert_source("https://a.example/1", schema_type="NewsItem", name="A")
    db.upsert_source("https://b.example/2", schema_type="NewsItem", name="B",
                     enabled=False)
    for i, (status, tokens) in enumerate([("SUCCESS", 100), ("SCHEMA_ERROR", 10),
                                          ("BLOCKED", 0),
                                          ("SKIPPED_UNCHANGED", 0)]):
        db.insert_run(url=f"https://a.example/1?r={i}", status=status,
                      source_id=sid, provider="fake" if tokens else None,
                      input_tokens=tokens)
    item_run = db.insert_run(url="https://a.example/item", status="SUCCESS",
                             source_id=sid, provider="fake", input_tokens=5)
    db.insert_item(run_id=item_run, source_url="https://a.example/item",
                   schema_type="NewsItem", content=NEWS_JSON,
                   dedup_hash="ab" * 32)
    db.insert_item(run_id=item_run, source_url="https://a.example/item2",
                   schema_type="NewsItem",
                   content=json.dumps({"title": "另一条", "summary": "s",
                                       "topics": [], "sentiment": "positive"}),
                   dedup_hash="ac" * 32)
    db.close()
    return connect_ro(path)


def test_connect_ro_rejects_missing_db(tmp_path):
    with pytest.raises(FileNotFoundError):
        connect_ro(tmp_path / "nope.db")


def test_status_summary(tmp_path):
    conn = _seed_ro(tmp_path)
    s = status_summary(conn)
    assert s["total"] == 5
    assert s["by_status"] == {"SUCCESS": 2, "SCHEMA_ERROR": 1,
                              "BLOCKED": 1, "SKIPPED_UNCHANGED": 1}
    assert s["success_rate"] == pytest.approx(2 / 5)
    assert s["today_tasks"] == 3           # 2 SUCCESS + 1 SCHEMA_ERROR
    assert s["today_input_tokens"] == 115  # 100 + 10 + 5


def test_daily_tokens(tmp_path):
    conn = _seed_ro(tmp_path)
    daily = daily_tokens(conn, days=30)
    assert len(daily) == 1                 # 全部产生于今天
    assert daily[0]["tasks"] == 3
    assert daily[0]["input_tokens"] == 115


def test_blocked_sources(tmp_path):
    conn = _seed_ro(tmp_path)
    blocked = blocked_sources(conn)
    assert len(blocked) == 1
    assert blocked[0]["status"] if "status" in blocked[0].keys() else True
    assert "r=2" in blocked[0]["url"]


def test_sources_with_last_run(tmp_path):
    conn = _seed_ro(tmp_path)
    rows = list_sources_with_last_run(conn)
    assert len(rows) == 2
    a = next(r for r in rows if r["name"] == "A")
    b = next(r for r in rows if r["name"] == "B")
    assert a["last_status"] == "SUCCESS" and a["enabled"] == 1
    assert b["enabled"] == 0 and b["last_status"] is None


def test_query_items_filters_and_pagination(tmp_path):
    conn = _seed_ro(tmp_path)
    rows, total = query_items(conn)
    assert total == 2 and len(rows) == 2
    rows, total = query_items(conn, keyword="关键词命中")
    assert total == 1 and rows[0]["item"]["title"] == "关键词命中测试"
    rows, total = query_items(conn, schema_type="CompetitorEvent")
    assert total == 0
    rows, total = query_items(conn, limit=1, offset=1)
    assert total == 2 and len(rows) == 1   # 分页：总数不变，页内截断
