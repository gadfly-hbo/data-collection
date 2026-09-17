"""Web 控制台：独立 HTML 前端 + FastAPI JSON API。

一键启动（非技术人员）：python scripts/webapp.py   （自动打开浏览器）
默认内置采集调度（与 run_daemon 相同的 tick 模型，单进程单写）——
**与 run_daemon 二选一运行**；`--no-scheduler` 可关闭调度只做触发与查看。
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import pathlib
import sqlite3
import sys
import threading
import webbrowser
from contextlib import asynccontextmanager

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from core.dotenv import load_dotenv

load_dotenv()

import yaml  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import FileResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import export_data  # noqa: E402
import run_daemon as daemon  # noqa: E402
from core.budget import BudgetExhausted  # noqa: E402
from models.registry import SCHEMA_REGISTRY  # noqa: E402
from storage.db import Database  # noqa: E402
from storage.queries import (blocked_sources, daily_tokens,  # noqa: E402
                             list_sources_with_last_run, query_items,
                             recent_runs, status_summary)

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
WEB_DIR = REPO_ROOT / "web"
DB_PATH = REPO_ROOT / "data" / "collector.db"
logger = logging.getLogger("webapp")


class SourceIn(BaseModel):
    url: str
    name: str | None = None
    schema_type: str
    interval_s: int = 3600
    enabled: bool = True
    use_browser: bool = False
    instruction: str = ""


class RunIn(BaseModel):
    source_id: int | None = None
    url: str | None = None
    schema_type: str = "NewsItem"
    use_browser: bool = False
    instruction: str = ""


def outcome_to_dict(outcome) -> dict:
    return {"status": outcome.status.value, "url": outcome.url,
            "error": outcome.error,
            "input_tokens": outcome.input_tokens,
            "output_tokens": outcome.output_tokens,
            "duration_ms": outcome.duration_ms, "run_id": outcome.run_id,
            "item": outcome.item.model_dump(mode="json")
            if outcome.item is not None else None}


async def _tick_loop(ctx: daemon.DaemonContext, db: Database) -> None:
    while True:
        try:
            await daemon.run_tick(ctx, db)
        except Exception:  # tick 内任何异常不得终止调度循环
            logger.exception("tick 执行异常")
        await asyncio.sleep(ctx.tick_s)


def create_app(ctx: daemon.DaemonContext, db: Database, db_path: pathlib.Path,
               *, with_scheduler: bool = True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = None
        if with_scheduler:
            task = asyncio.create_task(_tick_loop(ctx, db))
            logger.info("内置调度已启动（tick=%ss）", ctx.tick_s)
        yield
        if task is not None:
            task.cancel()

    app = FastAPI(title="采集控制台", lifespan=lifespan)
    app.state.ctx = ctx
    app.state.db = db
    app.state.db_path = db_path

    @app.get("/")
    def index():
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/api/summary")
    def api_summary():
        return {"summary": status_summary(db.conn),
                "daily": [dict(r) for r in daily_tokens(db.conn, days=14)],
                "blocked": [dict(r) for r in blocked_sources(db.conn, limit=10)]}

    @app.get("/api/runs")
    def api_runs(limit: int = 50):
        return [dict(r) for r in recent_runs(db.conn, limit=min(limit, 500))]

    @app.get("/api/sources")
    def api_sources():
        return [dict(r) for r in list_sources_with_last_run(db.conn)]

    @app.post("/api/sources")
    def api_source_upsert(body: SourceIn):
        try:
            source_id = db.upsert_source(
                url=body.url, schema_type=body.schema_type, name=body.name,
                interval_s=body.interval_s, enabled=body.enabled,
                use_browser=body.use_browser, instruction=body.instruction)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        return {"ok": True, "id": source_id}

    @app.delete("/api/sources/{source_id}")
    def api_source_delete(source_id: int):
        try:
            deleted = db.delete_source(source_id)
        except sqlite3.IntegrityError:
            raise HTTPException(
                status_code=409,
                detail="该来源存在关联台账，不可删除；请改用「停用」") from None
        if not deleted:
            raise HTTPException(status_code=404, detail="来源不存在")
        return {"ok": True}

    @app.post("/api/run")
    async def api_run(body: RunIn):
        if body.source_id is not None:
            row = db.conn.execute("SELECT * FROM sources WHERE id = ?",
                                  (body.source_id,)).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="来源不存在")
            source = dict(row)
        else:
            if not body.url:
                raise HTTPException(status_code=422, detail="需要 source_id 或 url")
            if body.schema_type not in SCHEMA_REGISTRY:
                raise HTTPException(status_code=400,
                                    detail=f"未知 schema_type: {body.schema_type}")
            source = {"id": None, "url": body.url,
                      "schema_type": body.schema_type,
                      "use_browser": int(body.use_browser),
                      "instruction": body.instruction}
        try:
            outcome = await daemon.run_source(source, ctx)
        except BudgetExhausted as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        if outcome is None:
            return {"ok": False,
                    "error": "任务被跳过（预算熔断或来源配置非法，详见日志/台账）"}
        return {"ok": outcome.ok, **outcome_to_dict(outcome)}

    @app.get("/api/items")
    def api_items(schema_type: str | None = None, keyword: str | None = None,
                  limit: int = 100):
        rows, total = query_items(db.conn, schema_type=schema_type or None,
                                  keyword=keyword or None,
                                  limit=min(limit, 500))
        return {"total": total, "items": rows}

    @app.get("/api/export")
    def api_export(format: str = "json", schema_type: str | None = None,
                   since: str | None = None, until: str | None = None):
        rows = export_data.fetch_rows(db_path, schema_type, since, until)
        renderer = {"csv": export_data.to_csv, "json": export_data.to_json,
                    "markdown": export_data.to_markdown}.get(format)
        if renderer is None:
            raise HTTPException(status_code=400, detail=f"未知格式: {format}")
        media = {"csv": "text/csv; charset=utf-8",
                 "json": "application/json; charset=utf-8",
                 "markdown": "text/markdown; charset=utf-8"}[format]
        ext = {"csv": "csv", "json": "json", "markdown": "md"}[format]
        return Response(content=renderer(rows), media_type=media,
                        headers={"Content-Disposition":
                                 f'attachment; filename="collector.{ext}"'})

    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
    return app


def main() -> int:
    parser = argparse.ArgumentParser(description="采集控制台（Web 前端，一键启动）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8500)
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    parser.add_argument("--no-scheduler", action="store_true",
                        help="不内置定时调度（单独运行 run_daemon 时使用）")
    parser.add_argument("--config", default="config/settings.yaml")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(level=getattr(logging, args.log_level.upper()),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = yaml.safe_load((REPO_ROOT / args.config).read_text())
    db = Database(DB_PATH)
    ctx, _ = daemon.build_context(settings, db=db)

    app = create_app(ctx, db, DB_PATH, with_scheduler=not args.no_scheduler)
    url = f"http://{args.host}:{args.port}"
    print(f"\n  采集控制台已启动：{url} （Ctrl-C 退出）\n"
          f"  定时调度：{'开' if not args.no_scheduler else '关'}｜"
          f"与 run_daemon 请二选一运行\n", flush=True)
    if not args.no_browser:
        threading.Timer(1.5, webbrowser.open, args=(url,)).start()
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
