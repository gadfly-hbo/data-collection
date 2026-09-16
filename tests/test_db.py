"""T2.2 + P2：SQLite 三表验收测试（内存 / 临时文件 SQLite）。"""
import sqlite3

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
    with pytest.raises(Exception, match="FOREIGN KEY constraint failed"):
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


# ---------- T5.2：来源配置校验 / 删除 / v1→v2 迁移 ----------

def test_wal_mode_enabled(tmp_path):
    db = Database(tmp_path / "wal.db")   # 内存库 journal_mode 固定为 memory，须用文件库验证
    assert db.conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    db.close()


def test_legacy_db_without_version_row_migrates(tmp_path):
    """P2-1：无 schema_version 行的遗留库打开时必须补迁移而非静默跳过。"""
    path = tmp_path / "orphan.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
    CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE,
        name TEXT, schema_type TEXT NOT NULL, interval_s INTEGER DEFAULT 3600,
        enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
    INSERT INTO sources (url, schema_type, name)
        VALUES ('https://old.example', 'NewsItem', '无版本行遗留');
    """)
    conn.commit()
    conn.close()

    db = Database(path)  # 修复前：静默跳过迁移，随后写入报 no column named use_browser
    assert db.conn.execute(
        "SELECT MAX(version) AS v FROM schema_version").fetchone()["v"] == SCHEMA_VERSION
    row = db.get_source("https://old.example")
    assert row["use_browser"] == 0 and row["instruction"] == ""
    db.upsert_source("https://old.example", schema_type="NewsItem", name="迁移后可写")
    db.close()

def test_validate_source_rejects_bad_input():
    db = Database(":memory:")
    with pytest.raises(ValueError, match="URL"):
        db.upsert_source("ftp://bad.example", schema_type="NewsItem")
    with pytest.raises(ValueError, match="schema_type"):
        db.upsert_source("https://a.example", schema_type="Nope")
    with pytest.raises(ValueError, match="interval_s"):
        db.upsert_source("https://a.example", schema_type="NewsItem", interval_s=10)


def test_delete_source_and_fk_guard():
    db = Database(":memory:")
    sid = db.upsert_source("https://a.example", schema_type="NewsItem")
    assert db.delete_source(999) is False          # 不存在的 id
    db.insert_run(url="https://a.example", status="SUCCESS", source_id=sid)
    with pytest.raises(Exception, match="FOREIGN KEY constraint failed"):
        db.delete_source(sid)                      # 有关联台账不可删除


def test_v1_database_migrates_to_v2(tmp_path):
    path = tmp_path / "old.db"
    conn = __import__("sqlite3").connect(path)
    conn.executescript("""
    CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE,
        name TEXT, schema_type TEXT NOT NULL, interval_s INTEGER DEFAULT 3600,
        enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE crawl_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER REFERENCES sources(id),
        url TEXT NOT NULL, raw_hash TEXT, status TEXT NOT NULL, provider TEXT,
        model TEXT, input_tokens INTEGER, output_tokens INTEGER,
        duration_ms INTEGER, error_msg TEXT,
        created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE extracted_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER REFERENCES crawl_runs(id),
        source_url TEXT NOT NULL, schema_type TEXT NOT NULL, content TEXT NOT NULL,
        dedup_hash TEXT UNIQUE, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL,
        applied_at TEXT DEFAULT (datetime('now')));
    INSERT INTO schema_version (version) VALUES (1);
    INSERT INTO sources (url, schema_type, name) VALUES ('https://old.example', 'NewsItem', '旧来源');
    """)
    conn.commit()
    conn.close()

    db = Database(path)
    assert db.conn.execute(
        "SELECT MAX(version) AS v FROM schema_version").fetchone()["v"] == SCHEMA_VERSION
    row = db.get_source("https://old.example")
    assert row["name"] == "旧来源"                # 旧数据保留
    assert row["use_browser"] == 0 and row["instruction"] == ""  # 新列已补默认值
    db.close()
