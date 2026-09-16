"""SQLite 初始化与写入接口：三张核心表 + schema_version 元数据表。

单 Worker 串行写入（AGENTS.md 硬性规则）：一个 Database 实例持有一个连接、
全进程复用，不做每次写入开连接；并发写路径在此层被设计排除。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA_VERSION = 1

_DDL = """
CREATE TABLE IF NOT EXISTS sources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT NOT NULL UNIQUE,
    name        TEXT,
    schema_type TEXT NOT NULL,
    interval_s  INTEGER DEFAULT 3600,
    enabled     INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crawl_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id      INTEGER REFERENCES sources(id),
    url            TEXT NOT NULL,
    raw_hash       TEXT,
    status         TEXT NOT NULL,
    provider       TEXT,
    model          TEXT,
    input_tokens   INTEGER,
    output_tokens  INTEGER,
    duration_ms    INTEGER,
    error_msg      TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS extracted_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER REFERENCES crawl_runs(id),
    source_url  TEXT NOT NULL,
    schema_type TEXT NOT NULL,
    content     TEXT NOT NULL,
    dedup_hash  TEXT UNIQUE,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_version (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    version    INTEGER NOT NULL,
    applied_at TEXT DEFAULT (datetime('now'))
);
"""


class Database:
    def __init__(self, path: str | Path = "data/collector.db"):
        path = str(path)
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._init_schema()

    @property
    def conn(self) -> sqlite3.Connection:
        return self._conn

    def _init_schema(self) -> None:
        """幂等建库：重复初始化不报错、不丢数据。"""
        self._conn.executescript(_DDL)
        row = self._conn.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
        if row["v"] is None:
            self._conn.execute("INSERT INTO schema_version (version) VALUES (?)",
                               (SCHEMA_VERSION,))
        elif row["v"] > SCHEMA_VERSION:
            raise RuntimeError(
                f"数据库 schema 版本 {row['v']} 高于代码支持的 {SCHEMA_VERSION}，请升级程序")
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    # ---------- sources ----------

    def upsert_source(self, url: str, schema_type: str, name: str | None = None,
                      interval_s: int = 3600, enabled: bool = True) -> int:
        self._conn.execute(
            "INSERT INTO sources (url, name, schema_type, interval_s, enabled) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(url) DO UPDATE SET name = excluded.name, "
            "schema_type = excluded.schema_type, interval_s = excluded.interval_s, "
            "enabled = excluded.enabled",
            (url, name, schema_type, interval_s, int(enabled)),
        )
        self._conn.commit()
        return self.get_source(url)["id"]

    def get_source(self, url: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM sources WHERE url = ?", (url,)).fetchone()

    # ---------- crawl_runs ----------

    def insert_run(self, *, url: str, status: str, source_id: int | None = None,
                   raw_hash: str | None = None, provider: str | None = None,
                   model: str | None = None, input_tokens: int = 0,
                   output_tokens: int = 0, duration_ms: int = 0,
                   error_msg: str | None = None) -> int:
        cur = self._conn.execute(
            "INSERT INTO crawl_runs (url, status, source_id, raw_hash, provider, "
            "model, input_tokens, output_tokens, duration_ms, error_msg) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (url, status, source_id, raw_hash, provider, model,
             input_tokens, output_tokens, duration_ms, error_msg),
        )
        self._conn.commit()
        return cur.lastrowid

    # ---------- extracted_items ----------

    def insert_item(self, *, run_id: int, source_url: str, schema_type: str,
                    content: str, dedup_hash: str) -> int | None:
        """写入结构化结果；dedup_hash 命中唯一约束时忽略并返回 None。"""
        cur = self._conn.execute(
            "INSERT OR IGNORE INTO extracted_items "
            "(run_id, source_url, schema_type, content, dedup_hash) VALUES (?, ?, ?, ?, ?)",
            (run_id, source_url, schema_type, content, dedup_hash),
        )
        self._conn.commit()
        return cur.lastrowid if cur.rowcount else None
