"""去重闸门：URL + 内容哈希联合判断，位于快照之后、LLM 调用之前。

命中条件（三者同时满足）：同一 URL、同一内容哈希、此前存在一次 SUCCESS 提取。
此前失败（SCHEMA_ERROR 等）的同内容记录不命中——内容未变也应重试提取；
不同 URL 的同内容互不干扰（内容相同不等于任务相同）。
"""
from __future__ import annotations

from storage.db import Database
from core.status import RunStatus


class DedupGate:
    def __init__(self, db: Database):
        self._db = db

    def seen(self, url: str, raw_hash: str) -> bool:
        """同 URL 同快照已有成功提取记录 → 命中，跳过本次 LLM 调用。"""
        row = self._db.conn.execute(
            "SELECT 1 FROM crawl_runs "
            "WHERE url = ? AND raw_hash = ? AND status = ? LIMIT 1",
            (url, raw_hash, RunStatus.SUCCESS.value),
        ).fetchone()
        return row is not None
