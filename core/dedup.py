"""去重闸门：URL + 内容哈希 + Schema 联合判断，位于快照之后、LLM 调用之前。

命中条件（四者同时满足）：同一 URL、同一内容哈希、同一 Schema、
且此前存在一次成功提取（extracted_items 有对应行）。
此前失败（SCHEMA_ERROR 等）的同内容记录不命中——内容未变也应重试提取；
不同 URL 或不同 Schema 互不干扰（改配 Schema 后必须按新 Schema 重新提取）。
"""
from __future__ import annotations

from core.status import RunStatus
from storage.db import Database


class DedupGate:
    def __init__(self, db: Database):
        self._db = db

    def seen(self, url: str, raw_hash: str, schema_type: str) -> bool:
        row = self._db.conn.execute(
            "SELECT 1 FROM crawl_runs cr "
            "JOIN extracted_items ei ON ei.run_id = cr.id "
            "WHERE cr.url = ? AND cr.raw_hash = ? AND cr.status = ? "
            "AND ei.schema_type = ? LIMIT 1",
            (url, raw_hash, RunStatus.SUCCESS.value, schema_type),
        ).fetchone()
        return row is not None
