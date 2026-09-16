"""日预算熔断：任务数 / input tokens 双上限（UTC 日），超限当日停止派发新任务。

input tokens 以台账上报为准；MiniMax 端点上报不可靠（TASKS.md 闸门 1 结论），
任务数上限是主防线，token 上限对上报规范的供应商（如 Gemini）生效。
统计口径为消耗 LLM 调用的终态（SUCCESS / SCHEMA_ERROR），SKIPPED_* 不计。
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone

from core.status import BILLABLE_STATUSES
from storage.db import Database


class BudgetExhausted(RuntimeError):
    """当日预算已达上限。"""


class BudgetGuard:
    def __init__(self, db: Database, *, max_tasks_per_day: int,
                 max_input_tokens_per_day: int,
                 today: Callable[[], str] | None = None):
        self._db = db
        self.max_tasks = max_tasks_per_day
        self.max_tokens = max_input_tokens_per_day
        self._today = today or (
            lambda: datetime.now(timezone.utc).strftime("%Y-%m-%d"))

    def usage(self) -> tuple[int, int]:
        placeholders = ",".join("?" * len(BILLABLE_STATUSES))
        row = self._db.conn.execute(
            f"SELECT COUNT(*) AS tasks, COALESCE(SUM(input_tokens), 0) AS tokens "
            f"FROM crawl_runs WHERE status IN ({placeholders}) "
            f"AND substr(created_at, 1, 10) = ?",
            (*BILLABLE_STATUSES, self._today()),
        ).fetchone()
        return row["tasks"], row["tokens"]

    def check(self) -> tuple[int, int]:
        """超限抛 BudgetExhausted（消息含用量与上限）；否则返回当前 (tasks, tokens)。"""
        tasks, tokens = self.usage()
        if tasks >= self.max_tasks:
            raise BudgetExhausted(
                f"今日任务数已达上限：{tasks}/{self.max_tasks}，停止派发新任务")
        if tokens >= self.max_tokens:
            raise BudgetExhausted(
                f"今日 input tokens 已达上限：{tokens}/{self.max_tokens}，停止派发新任务")
        return tasks, tokens
