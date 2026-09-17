"""T3.3：日预算熔断验收测试。"""
from datetime import datetime, timedelta, timezone

import pytest

from core.budget import BudgetExhausted, BudgetGuard
from storage.db import Database

# 不写死日期：UTC 日期翻转（午夜跨天）时测试不得失效
TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")
YESTERDAY = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")


def _guard(db, *, max_tasks=3, max_tokens=1000, today=TODAY):
    return BudgetGuard(db, max_tasks_per_day=max_tasks,
                       max_input_tokens_per_day=max_tokens, today=lambda: today)


def _billable_run(db, url, *, status="SUCCESS", input_tokens=100, created_at=None):
    db.insert_run(url=url, status=status, provider="fake", model="m",
                  input_tokens=input_tokens)
    if created_at:
        db.conn.execute("UPDATE crawl_runs SET created_at = ? WHERE url = ?",
                        (created_at, url))
        db.conn.commit()


def test_empty_ledger_within_budget():
    guard = _guard(Database(":memory:"))
    assert guard.check() == (0, 0)


def test_task_cap_trips_with_readable_message():
    db = Database(":memory:")
    guard = _guard(db, max_tasks=3)
    for i in range(3):
        _billable_run(db, f"https://a.example/{i}")
    with pytest.raises(BudgetExhausted, match="任务数.*3/3"):
        guard.check()


def test_token_cap_trips():
    db = Database(":memory:")
    guard = _guard(db, max_tokens=500)
    _billable_run(db, "https://a.example/1", input_tokens=500)
    with pytest.raises(BudgetExhausted, match="input tokens.*500/500"):
        guard.check()


def test_skipped_states_do_not_count():
    db = Database(":memory:")
    guard = _guard(db, max_tasks=2)
    for i in range(5):  # 5 次 SKIPPED / BLOCKED 不消耗预算
        db.insert_run(url=f"https://a.example/{i}", status="SKIPPED_UNCHANGED")
    db.insert_run(url="https://a.example/x", status="BLOCKED")
    assert guard.usage() == (0, 0)
    guard.check()  # 不抛


def test_schema_error_counts_as_billable_task():
    db = Database(":memory:")
    guard = _guard(db, max_tasks=2)
    _billable_run(db, "https://a.example/1", status="SCHEMA_ERROR", input_tokens=0)
    _billable_run(db, "https://a.example/2", status="SCHEMA_ERROR", input_tokens=0)
    with pytest.raises(BudgetExhausted, match="任务数"):
        guard.check()


def test_other_days_not_counted():
    db = Database(":memory:")
    guard = _guard(db, max_tasks=2)
    _billable_run(db, "https://a.example/1",
                  created_at=f"{YESTERDAY} 10:00:00")  # 昨天的量不占今天预算
    _billable_run(db, "https://a.example/2",
                  created_at=f"{TODAY} 09:00:00")
    tasks, tokens = guard.check()
    assert (tasks, tokens) == (1, 100)
