"""只读分析查询：监控面板与运维排查共用（全部 SELECT，无写路径）。"""
from __future__ import annotations

import json
import pathlib
import sqlite3

_BILLABLE = ("SUCCESS", "SCHEMA_ERROR")


def connect_ro(db_path: str | pathlib.Path) -> sqlite3.Connection:
    """只读打开（mode=ro）：面板与采集进程并发互不干扰。"""
    path = pathlib.Path(db_path)
    if not path.exists():
        raise FileNotFoundError(f"数据库不存在：{path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def status_summary(conn: sqlite3.Connection) -> dict:
    total = conn.execute("SELECT COUNT(*) AS n FROM crawl_runs").fetchone()["n"]
    by_status = {r["status"]: r["n"] for r in conn.execute(
        "SELECT status, COUNT(*) AS n FROM crawl_runs GROUP BY status")}
    placeholders = ",".join("?" * len(_BILLABLE))
    today = conn.execute(
        f"SELECT COUNT(*) AS tasks, COALESCE(SUM(input_tokens), 0) AS tokens "
        f"FROM crawl_runs WHERE status IN ({placeholders}) "
        f"AND substr(created_at, 1, 10) = date('now')",
        _BILLABLE).fetchone()
    return {"total": total, "by_status": by_status,
            "success_rate": (by_status.get("SUCCESS", 0) / total) if total else 0.0,
            "today_tasks": today["tasks"],
            "today_input_tokens": today["tokens"]}


def daily_tokens(conn: sqlite3.Connection, days: int = 30) -> list[sqlite3.Row]:
    placeholders = ",".join("?" * len(_BILLABLE))
    return conn.execute(
        f"SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS tasks, "
        f"COALESCE(SUM(input_tokens), 0) AS input_tokens, "
        f"COALESCE(SUM(output_tokens), 0) AS output_tokens "
        f"FROM crawl_runs WHERE status IN ({placeholders}) "
        f"GROUP BY day ORDER BY day DESC LIMIT ?",
        (*_BILLABLE, days)).fetchall()


def blocked_sources(conn: sqlite3.Connection, limit: int = 50) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT url, error_msg, created_at FROM crawl_runs "
        "WHERE status = 'BLOCKED' ORDER BY id DESC LIMIT ?", (limit,)).fetchall()


def list_sources_with_last_run(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT s.*, "
        "(SELECT r.status FROM crawl_runs r WHERE r.source_id = s.id "
        " ORDER BY r.id DESC LIMIT 1) AS last_status, "
        "(SELECT MAX(r.created_at) FROM crawl_runs r WHERE r.source_id = s.id) "
        " AS last_run_at "
        "FROM sources s ORDER BY s.id").fetchall()


def query_items(conn: sqlite3.Connection, *, schema_type: str | None = None,
                keyword: str | None = None, since: str | None = None,
                until: str | None = None, limit: int = 200,
                offset: int = 0) -> tuple[list[dict], int]:
    """分页查询结构化结果，返回 (rows, total)；content 解析失败降级为 _raw。"""
    sql = "FROM extracted_items WHERE 1 = 1"
    params: list = []
    if schema_type:
        sql += " AND schema_type = ?"
        params.append(schema_type)
    if keyword:
        sql += " AND (content LIKE ? OR source_url LIKE ?)"
        params += [f"%{keyword}%", f"%{keyword}%"]
    if since:
        sql += " AND date(created_at) >= date(?)"
        params.append(since)
    if until:
        sql += " AND date(created_at) <= date(?)"
        params.append(until)
    total = conn.execute("SELECT COUNT(*) AS n " + sql, params).fetchone()["n"]
    rows = conn.execute(
        "SELECT id, run_id, source_url, schema_type, content, created_at " + sql +
        " ORDER BY id DESC LIMIT ? OFFSET ?", (*params, limit, offset)).fetchall()
    items = []
    for r in rows:
        try:
            item = json.loads(r["content"])
        except json.JSONDecodeError:
            item = {"_raw": r["content"]}
        items.append({"id": r["id"], "run_id": r["run_id"],
                      "source_url": r["source_url"],
                      "schema_type": r["schema_type"],
                      "created_at": r["created_at"], "item": item})
    return items, total
