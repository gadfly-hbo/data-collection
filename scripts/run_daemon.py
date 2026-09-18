"""后台守护进程：周期 tick 扫描 sources 表，按 interval_s 调度采集。

调度模型：单个 APScheduler tick 任务（默认每 30s）从 sources 表读取启用来源——
面板 / 迁移脚本对来源的新增、启停、改间隔在下一个 tick 即生效（T5.2）；
单 Worker 串行（SQLite 单写 + 同域限速）；SIGINT/SIGTERM 排干在途任务后退出。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import pathlib
import signal
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from core.dotenv import load_dotenv

load_dotenv()

import yaml  # noqa: E402
from apscheduler.schedulers.asyncio import AsyncIOScheduler  # noqa: E402

from core.budget import BudgetExhausted, BudgetGuard  # noqa: E402
from core.dedup import DedupGate  # noqa: E402
from core.fetcher import Fetcher  # noqa: E402
from core.pipeline import Pipeline, RunStatus, TaskSpec  # noqa: E402
from core.providers.factory import create_provider_stack  # noqa: E402
from models.registry import get_schema  # noqa: E402
from storage.db import Database  # noqa: E402
from storage.ledger import RunLedger  # noqa: E402
from storage.raw_store import RawStore  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
logger = logging.getLogger("daemon")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class DaemonContext:
    pipeline: Pipeline
    fetcher: Fetcher
    budget: BudgetGuard | None
    worker_lock: asyncio.Lock
    notify_enabled: bool = False
    tick_s: int = 30
    last_run: dict[str, datetime] = field(default_factory=dict)  # url → 上次执行时刻
    clock: Callable[[], datetime] = _utcnow


def notify(title: str, message: str, enabled: bool) -> None:
    """macOS 本地通知（osascript）；失败仅记日志，不影响采集。"""
    if not enabled:
        return
    try:
        subprocess.Popen(
            ["osascript", "-e",
             f'display notification {json.dumps(message)} '
             f'with title {json.dumps(title)}'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as e:
        logger.warning("通知发送失败：%s", e)


def enabled_sources(db: Database) -> list:
    return db.conn.execute(
        "SELECT * FROM sources WHERE enabled = 1 ORDER BY id").fetchall()


async def run_source(source, ctx: DaemonContext) -> None:
    """单来源采集：串行 Worker + 预算闸门 + 告警出口。"""
    url = source["url"]
    async with ctx.worker_lock:
        if ctx.budget is not None:
            try:
                ctx.budget.check()
            except BudgetExhausted as e:
                logger.warning("预算熔断，跳过本次调度 %s：%s", url, e)
                return
        try:
            spec = TaskSpec(url=url,
                            schema=get_schema(source["schema_type"]),
                            instruction=source["instruction"] or "",
                            source_id=source["id"],
                            use_browser=bool(source["use_browser"]))
            outcome = await ctx.pipeline.run(spec)
        except Exception as e:  # 非法配置、认证失败等：告警并继续本轮剩余来源
            logger.error("任务异常 %s：%s: %s", url, type(e).__name__, e)
            notify("采集任务异常", f"{url}\n{type(e).__name__}: {e}",
                   ctx.notify_enabled)
            return
        if outcome.status is RunStatus.BLOCKED:
            logger.error("[BLOCKED] %s：%s", url, outcome.error)
            notify("采集被目标站封锁", f"{url}\n{outcome.error}",
                   ctx.notify_enabled)
        elif outcome.ok:
            logger.info("[%s] %s tokens=(%d,%d) %dms run_id=%s",
                        outcome.status.value, url, outcome.input_tokens,
                        outcome.output_tokens, outcome.duration_ms,
                        outcome.run_id)
        else:
            logger.warning("[%s] %s error=%s", outcome.status.value, url,
                           outcome.error)
        return outcome  # Web 控制台复用本函数时取终态；跳过/异常路径返回 None


async def run_tick(ctx: DaemonContext, db: Database) -> None:
    """扫描 sources 表：到期（now ≥ last_run + 当前 interval_s）的启用来源各执行一次。

    last_run 记派发时刻（预算熔断跳过同样推进，避免熔断期每 tick 刷告警）；
    到期时间按当次扫描时的 interval_s 现算——改间隔在下一个 tick 即按新值生效。
    """
    now = ctx.clock()
    for src in enabled_sources(db):
        url = src["url"]
        last = ctx.last_run.get(url)
        if last is not None and now < last + timedelta(seconds=src["interval_s"]):
            continue
        ctx.last_run[url] = ctx.clock()
        await run_source(src, ctx)


def build_context(settings: dict, *,
                  db: Database | None = None) -> tuple[DaemonContext, Database]:
    db = db or Database(REPO_ROOT / "data" / "collector.db")
    fetch_cfg = settings.get("fetch", {})
    fetcher = Fetcher(
        user_agent=fetch_cfg.get("user_agent", "DataCollectorBot/0.1"),
        min_interval_per_host_s=fetch_cfg.get("min_interval_per_host_s", 5.0),
        respect_robots=fetch_cfg.get("respect_robots", True))
    budget_cfg = settings.get("budget") or {}
    budget = (BudgetGuard(db,
                          max_tasks_per_day=budget_cfg["max_tasks_per_day"],
                          max_input_tokens_per_day=budget_cfg[
                              "max_input_tokens_per_day"])
              if budget_cfg else None)
    pipeline = Pipeline(fetcher, create_provider_stack(settings["provider"]),
                        raw_store=RawStore(REPO_ROOT / "data" / "raw"),
                        dedup=DedupGate(db), ledger=RunLedger(db))
    ctx = DaemonContext(
        pipeline=pipeline, fetcher=fetcher, budget=budget,
        worker_lock=asyncio.Lock(),
        notify_enabled=(settings.get("alerts") or {}).get("macos_notify", False),
        tick_s=int((settings.get("scheduler") or {}).get("tick_s", 30)))
    return ctx, db


async def main_async(args) -> int:
    try:
        settings = yaml.safe_load((REPO_ROOT / args.config).read_text())
        ctx, db = build_context(settings)
    except (KeyError, RuntimeError, ValueError) as e:
        logger.error("配置错误：%s", e)
        return 2

    sources = enabled_sources(db)
    if not sources:
        logger.error("sources 表无启用来源——先运行 scripts/import_sources.py "
                     "迁移 sources.yaml，或在面板中添加来源")
        return 2
    logger.info("启用来源 %d 个：%s", len(sources), [s["url"] for s in sources])

    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(run_tick, "interval", seconds=ctx.tick_s,
                      args=[ctx, db], id="tick", next_run_time=_utcnow(),
                      max_instances=1, coalesce=True)
    scheduler.start()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _on_signal(sig) -> None:
        if stop.is_set():  # 第二次信号：在途排干期间允许强制退出
            logger.error("再次收到 %s，强制退出（在途任务可能中断）", sig.name)
            os._exit(130)
        logger.info("收到 %s，等待在途任务排干（再次发送可强制退出）", sig.name)
        stop.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _on_signal, sig)
    logger.info("守护进程已启动（tick=%ss，Ctrl-C 优雅退出）", ctx.tick_s)
    await stop.wait()
    logger.info("收到退出信号，等待在途任务排干…")
    scheduler.shutdown(wait=True)
    await ctx.fetcher.aclose()
    db.close()
    logger.info("守护进程已退出")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="定时采集守护进程（sources 表驱动）")
    parser.add_argument("--config", default="config/settings.yaml")
    parser.add_argument("--log-level", default="INFO")
    parser.add_argument("--log-file", default=None,
                        help="日志写入文件（后台长期观测用）；缺省输出到终端")
    args = parser.parse_args()

    fmt = "%(asctime)s %(levelname)s %(name)s %(message)s"
    if args.log_file:
        logfile = pathlib.Path(args.log_file)
        if not logfile.is_absolute():
            logfile = REPO_ROOT / logfile
        logfile.parent.mkdir(parents=True, exist_ok=True)
        logging.basicConfig(level=getattr(logging, args.log_level.upper()),
                            format=fmt, filename=str(logfile))
    else:
        logging.basicConfig(level=getattr(logging, args.log_level.upper()), format=fmt)
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
