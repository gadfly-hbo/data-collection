"""T3.4 + T5.2：守护进程核心逻辑测试（tick 调度模型，注入 fake pipeline）。"""
import asyncio
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import run_daemon as rd  # noqa: E402
from core.budget import BudgetExhausted, BudgetGuard  # noqa: E402
from core.pipeline import RunOutcome, RunStatus  # noqa: E402
from storage.db import Database  # noqa: E402


class _FakePipeline:
    def __init__(self, outcomes=None, error=None):
        self.calls: list = []
        self.outcomes = outcomes or []
        self.error = error

    async def run(self, spec):
        self.calls.append(spec)
        if self.error is not None:
            raise self.error
        return self.outcomes[min(len(self.calls) - 1, len(self.outcomes) - 1)]


def _source(**overrides) -> dict:
    base = {"id": 7, "url": "https://a.example/1", "schema_type": "NewsItem",
            "interval_s": 60, "enabled": 1, "use_browser": 0, "instruction": ""}
    base.update(overrides)
    return base


def _ctx(pipeline, budget=None, notify_enabled=False, clock=None) -> rd.DaemonContext:
    return rd.DaemonContext(pipeline=pipeline, fetcher=None, budget=budget,
                            worker_lock=asyncio.Lock(), notify_enabled=notify_enabled,
                            clock=clock or rd._utcnow)


def _outcome(status, **kwargs):
    return RunOutcome(status, "https://a.example/1", **kwargs)


# ---------- 来源加载（sources 表驱动） ----------

def test_enabled_sources_reads_table():
    db = Database(":memory:")
    db.upsert_source("https://a.example/1", schema_type="NewsItem", name="A")
    db.upsert_source("https://b.example/2", schema_type="NewsItem", name="B",
                     enabled=False)
    rows = rd.enabled_sources(db)
    assert [r["url"] for r in rows] == ["https://a.example/1"]  # 停用来源不出现


# ---------- 单来源任务 ----------

async def test_budget_exhausted_skips_without_llm_call(caplog):
    db = Database(":memory:")
    budget = BudgetGuard(db, max_tasks_per_day=0, max_input_tokens_per_day=999999)
    pipeline = _FakePipeline(outcomes=[_outcome(RunStatus.SUCCESS)])
    caplog.set_level(logging.WARNING, logger="daemon")

    await rd.run_source(_source(), _ctx(pipeline, budget=budget))

    assert pipeline.calls == []  # 熔断：不派发
    assert any("预算熔断" in r.message for r in caplog.records)


async def test_blocked_logs_error_and_notifies(caplog, monkeypatch):
    sent: list[tuple[str, str, bool]] = []
    monkeypatch.setattr(rd, "notify", lambda t, m, e: sent.append((t, m, e)))
    pipeline = _FakePipeline(outcomes=[_outcome(RunStatus.BLOCKED, error="403")])
    caplog.set_level(logging.ERROR, logger="daemon")

    await rd.run_source(_source(), _ctx(pipeline, notify_enabled=True))

    assert any("BLOCKED" in r.message for r in caplog.records)
    assert sent and sent[0][0] == "采集被目标站封锁" and sent[0][2] is True


async def test_provider_exception_logs_error_and_notifies(caplog, monkeypatch):
    sent: list[tuple[str, str, bool]] = []
    monkeypatch.setattr(rd, "notify", lambda t, m, e: sent.append((t, m, e)))
    pipeline = _FakePipeline(error=RuntimeError("API key not valid"))
    caplog.set_level(logging.ERROR, logger="daemon")

    await rd.run_source(_source(), _ctx(pipeline, notify_enabled=True))

    assert any("API key not valid" in r.message for r in caplog.records)
    assert sent and sent[0][0] == "采集任务异常"


async def test_run_source_passes_source_id_and_browser_flag(caplog):
    pipeline = _FakePipeline(outcomes=[_outcome(RunStatus.SUCCESS, run_id=42)])
    caplog.set_level(logging.INFO, logger="daemon")

    await rd.run_source(_source(use_browser=1), _ctx(pipeline))

    spec = pipeline.calls[0]
    assert spec.source_id == 7 and spec.use_browser is True  # 台账关联 + 站点级开关
    assert any("run_id=42" in r.message for r in caplog.records)


async def test_invalid_schema_type_isolated(caplog):
    """P3：sources 表被写入非法 schema_type 时，单来源报错不中断本轮其余来源。"""
    pipeline = _FakePipeline(outcomes=[])
    caplog.set_level(logging.ERROR, logger="daemon")
    await rd.run_source({"id": 1, "url": "https://c.example/1",
                         "schema_type": "Nope", "interval_s": 60, "enabled": 1,
                         "use_browser": 0, "instruction": ""},
                        _ctx(pipeline))
    assert pipeline.calls == []
    assert any("Nope" in r.message for r in caplog.records)


async def test_worker_lock_serializes_concurrent_sources():
    events: list[str] = []

    class _SlowPipeline:
        async def run(self, spec):
            events.append(f"start:{spec.url}")
            await asyncio.sleep(0.01)
            events.append(f"end:{spec.url}")
            return _outcome(RunStatus.SUCCESS)

    ctx = _ctx(_SlowPipeline())
    await asyncio.gather(rd.run_source(_source(), ctx),
                         rd.run_source(_source(url="https://a.example/2"), ctx))
    assert events == ["start:https://a.example/1", "end:https://a.example/1",
                      "start:https://a.example/2", "end:https://a.example/2"]


# ---------- T5.2：tick 调度（sources 表每轮读取，配置变更即时生效） ----------

async def test_tick_runs_enabled_sources_only():
    db = Database(":memory:")
    db.upsert_source("https://a.example/1", schema_type="NewsItem", interval_s=60)
    db.upsert_source("https://b.example/2", schema_type="NewsItem", interval_s=60,
                     enabled=False)
    pipeline = _FakePipeline(outcomes=[_outcome(RunStatus.SUCCESS)])
    ctx = _ctx(pipeline)

    await rd.run_tick(ctx, db)
    assert [s.url for s in pipeline.calls] == ["https://a.example/1"]


async def test_tick_respects_interval_before_rerun():
    db = Database(":memory:")
    db.upsert_source("https://a.example/1", schema_type="NewsItem", interval_s=60)
    pipeline = _FakePipeline(outcomes=[_outcome(RunStatus.SUCCESS)])
    clock = {"now": datetime(2026, 9, 16, 12, 0, tzinfo=timezone.utc)}
    ctx = _ctx(pipeline, clock=lambda: clock["now"])

    await rd.run_tick(ctx, db)
    await rd.run_tick(ctx, db)                          # 未到期：不重复执行
    assert len(pipeline.calls) == 1

    clock["now"] += timedelta(seconds=30)
    await rd.run_tick(ctx, db)
    assert len(pipeline.calls) == 1

    clock["now"] += timedelta(seconds=31)               # 超过 interval_s=60
    await rd.run_tick(ctx, db)
    assert len(pipeline.calls) == 2


async def test_interval_change_takes_effect_next_tick():
    db = Database(":memory:")
    db.upsert_source("https://a.example/1", schema_type="NewsItem", interval_s=60)
    pipeline = _FakePipeline(outcomes=[_outcome(RunStatus.SUCCESS)])
    clock = {"now": datetime(2026, 9, 16, 12, 0, tzinfo=timezone.utc)}
    ctx = _ctx(pipeline, clock=lambda: clock["now"])

    await rd.run_tick(ctx, db)
    # 面板把间隔从 60s 改为 3600s → 下一次到期时间按新间隔计算
    db.upsert_source("https://a.example/1", schema_type="NewsItem", interval_s=3600)
    clock["now"] += timedelta(seconds=60)
    await rd.run_tick(ctx, db)
    assert len(pipeline.calls) == 1                     # 新间隔下仍未到期

    clock["now"] += timedelta(seconds=3600)
    await rd.run_tick(ctx, db)
    assert len(pipeline.calls) == 2


# ---------- 组装 ----------

def test_build_context_wires_components(monkeypatch):
    monkeypatch.setenv("MINIMAX_API_KEY", "test-key")
    settings = {
        "provider": {"primary": "gemini", "fallback": "anthropic-compat",
                     "gemini": {}, "anthropic-compat": {
                         "model": "MiniMax-M3",
                         "base_url": "https://api.minimax.cn/anthropic",
                         "api_key_env": "MINIMAX_API_KEY", "rpm": 30}},
        "budget": {"max_tasks_per_day": 5, "max_input_tokens_per_day": 1000},
        "alerts": {"macos_notify": True},
        "scheduler": {"tick_s": 15},
    }
    db = Database(":memory:")
    ctx, db2 = rd.build_context(settings, db=db)
    assert ctx.tick_s == 15
    assert ctx.budget is not None and ctx.budget.max_tasks == 5
    assert ctx.notify_enabled is True
    assert db2 is db
