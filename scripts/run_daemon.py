"""后台守护进程：APScheduler 按 sources.yaml 定时采集。

单 Worker 串行执行（SQLite 单写 + 同域限速，AGENTS.md 硬性规则）；
SIGINT/SIGTERM 排干在途任务后退出；blocked 与供应商级异常（认证失败等）
走 ERROR 日志 + 可选 macOS 本地通知。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import pathlib
import signal
import subprocess
import sys
from dataclasses import dataclass
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


@dataclass
class DaemonContext:
    pipeline: Pipeline
    fetcher: Fetcher
    budget: BudgetGuard | None
    worker_lock: asyncio.Lock
    source_ids: dict[str, int]
    notify_enabled: bool = False


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


def load_sources(path: pathlib.Path) -> list[dict]:
    data = yaml.safe_load(path.read_text())
    return [s for s in data.get("sources", []) if s.get("enabled", True)]


async def run_source(source: dict, ctx: DaemonContext) -> None:
    """单来源采集：串行 Worker + 预算闸门 + 告警出口。"""
    url = source["url"]
    async with ctx.worker_lock:
        if ctx.budget is not None:
            try:
                ctx.budget.check()
            except BudgetExhausted as e:
                logger.warning("预算熔断，跳过本次调度 %s：%s", url, e)
                return
        spec = TaskSpec(url=url,
                        schema=get_schema(source["schema_type"]),
                        instruction=source.get("instruction") or "",
                        source_id=ctx.source_ids.get(url))
        try:
            outcome = await ctx.pipeline.run(spec)
        except Exception as e:  # 认证失败等供应商级异常：告警并继续调度
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


def build_context(settings: dict, sources: list[dict], *,
                  db: Database | None = None) -> tuple[DaemonContext, Database]:
    """组装上下文；来源白名单 upsert 进 sources 表（台账记 source_id）。"""
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
    source_ids: dict[str, int] = {}
    for src in sources:
        source_ids[src["url"]] = db.upsert_source(
            src["url"], schema_type=src["schema_type"], name=src.get("name"),
            interval_s=int(src.get("interval_s", 3600)),
            enabled=bool(src.get("enabled", True)))
    pipeline = Pipeline(fetcher, create_provider_stack(settings["provider"]),
                        raw_store=RawStore(REPO_ROOT / "data" / "raw"),
                        dedup=DedupGate(db), ledger=RunLedger(db))
    ctx = DaemonContext(
        pipeline=pipeline, fetcher=fetcher, budget=budget,
        worker_lock=asyncio.Lock(), source_ids=source_ids,
        notify_enabled=(settings.get("alerts") or {}).get("macos_notify", False))
    return ctx, db


async def main_async(args) -> int:
    logging.basicConfig(level=getattr(logging, args.log_level.upper()),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = yaml.safe_load((REPO_ROOT / args.config).read_text())
    sources = load_sources(REPO_ROOT / args.sources)
    if not sources:
        logger.error("sources.yaml 无启用的采集来源，退出")
        return 2
    ctx, db = build_context(settings, sources)

    scheduler = AsyncIOScheduler(timezone="UTC")
    now = datetime.now(timezone.utc)
    for i, src in enumerate(sources):
        interval = int(src.get("interval_s", 3600))
        scheduler.add_job(run_source, "interval", seconds=interval,
                          args=[src, ctx], id=f"source:{src['url']}",
                          next_run_time=now + timedelta(seconds=i * 5),  # 错峰首跑
                          max_instances=1, coalesce=True)
        logger.info("调度来源 %s（间隔 %ss）", src["url"], interval)
    scheduler.start()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    logger.info("守护进程已启动（Ctrl-C 优雅退出）")
    await stop.wait()
    logger.info("收到退出信号，等待在途任务排干…")
    scheduler.shutdown(wait=True)
    await ctx.fetcher.aclose()
    db.close()
    logger.info("守护进程已退出")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="定时采集守护进程")
    parser.add_argument("--config", default="config/settings.yaml")
    parser.add_argument("--sources", default="config/sources.yaml")
    parser.add_argument("--log-level", default="INFO")
    return asyncio.run(main_async(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
