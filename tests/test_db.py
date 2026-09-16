"""T2.2：SQLite 三表验收测试（内存 / 临时文件 SQLite）。"""
import pytest

from storage.db import SCHEMA_VERSION, Database


def _news_content(title: str = "标题") -> str:
    import json
    return json.dumps({"title": title, "summary": "摘要", "topics": ["t"],
                       "sentiment": "neutral"}, ensure_ascii=False)


def test_init_idempotent_and_data_survives_reopen(tmp_path):
    path = tmp_path / "collector.db"
    db1 = Database(path)
    sid = db1.upsert_source("https://a.example", schema_type="NewsItem", name="A")
    db1.close()

    db2 = Database(path)  # 重复初始化：不报错、不丢数据
    assert db2.get_source("https://a.example")["id"] == sid
    row = db2.conn.execute("SELECT version FROM schema_version").fetchone()
    assert row["version"] == SCHEMA_VERSION
    db2.close()


def test_upsert_source_updates_in_place(tmp_path):
    db = Database(":memory:")
    id1 = db.upsert_source("https://a.example", schema_type="NewsItem",
                           name="旧名", interval_s=3600)
    id2 = db.upsert_source("https://a.example", schema_type="NewsItem",
                           name="新名", interval_s=60, enabled=False)
    assert id1 == id2  # 同 url 不产生第二行
    row = db.get_source("https://a.example")
    assert row["name"] == "新名" and row["interval_s"] == 60 and row["enabled"] == 0


def test_insert_run_roundtrip(tmp_path):
    db = Database(":memory:")
    run_id = db.insert_run(url="https://a.example/1", status="SUCCESS",
                           raw_hash="ab" * 32, provider="fake", model="fake-model",
                           input_tokens=100, output_tokens=20, duration_ms=1234)
    row = db.conn.execute("SELECT * FROM crawl_runs WHERE id = ?", (run_id,)).fetchone()
    assert row["url"] == "https://a.example/1"
    assert row["status"] == "SUCCESS"
    assert row["input_tokens"] == 100 and row["duration_ms"] == 1234
    assert row["created_at"]  # 台账时间戳由库端生成


def test_insert_item_dedup_hash_unique(tmp_path):
    db = Database(":memory:")
    run_id = db.insert_run(url="https://a.example/1", status="SUCCESS")
    h = "cd" * 32
    item_id = db.insert_item(run_id=run_id, source_url="https://a.example/1",
                             schema_type="NewsItem", content=_news_content(),
                             dedup_hash=h)
    assert item_id is not None
    duplicate = db.insert_item(run_id=run_id, source_url="https://a.example/1",
                               schema_type="NewsItem", content=_news_content(),
                               dedup_hash=h)
    assert duplicate is None  # 内容重复：忽略写入
    count = db.conn.execute("SELECT COUNT(*) AS c FROM extracted_items").fetchone()["c"]
    assert count == 1


def test_item_foreign_key_enforced(tmp_path):
    db = Database(":memory:")
    with pytest.raises(Exception, match=" FOREIGN KEY|foreign key"):
        db.insert_item(run_id=999, source_url="https://x", schema_type="NewsItem",
                       content=_news_content(), dedup_hash="ee" * 32)


def test_future_schema_version_rejected(tmp_path):
    path = tmp_path / "future.db"
    db = Database(path)
    db.conn.execute("UPDATE schema_version SET version = ?", (SCHEMA_VERSION + 1,))
    db.conn.commit()
    db.close()
    with pytest.raises(RuntimeError, match="高于"):
        Database(path)
