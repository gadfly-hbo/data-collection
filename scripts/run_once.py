"""单次采集入口：python scripts/run_once.py --url <url> [--schema NewsItem]

退出码：0 = SUCCESS / SKIPPED_*（按设计跳过）；1 = 任务失败；2 = 环境/配置错误。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from core.dotenv import load_dotenv

load_dotenv()

import yaml  # noqa: E402

from core.dedup import DedupGate  # noqa: E402
from core.fetcher import Fetcher  # noqa: E402
from core.pipeline import Pipeline, TaskSpec  # noqa: E402
from core.providers.factory import resolve_provider  # noqa: E402
from models.registry import get_schema  # noqa: E402
from storage.db import Database  # noqa: E402
from storage.ledger import RunLedger  # noqa: E402
from storage.raw_store import RawStore  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load_settings(path: str) -> dict:
    p = pathlib.Path(path)
    if not p.is_absolute():
        p = REPO_ROOT / p
    return yaml.safe_load(p.read_text())


def _emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


async def _run(args: argparse.Namespace) -> int:
    settings = _load_settings(args.config)
    fetch_cfg = settings.get("fetch", {})
    try:
        provider = resolve_provider(settings["provider"])
        schema = get_schema(args.schema)
    except (RuntimeError, KeyError) as e:
        _emit({"error": str(e)})
        return 2

    db = Database(REPO_ROOT / "data" / "collector.db")
    async with Fetcher(
        user_agent=fetch_cfg.get("user_agent", "DataCollectorBot/0.1"),
        min_interval_per_host_s=fetch_cfg.get("min_interval_per_host_s", 5.0),
        respect_robots=fetch_cfg.get("respect_robots", True),
    ) as fetcher:
        pipeline = Pipeline(fetcher, provider,
                            raw_store=RawStore(REPO_ROOT / "data" / "raw"),
                            dedup=DedupGate(db),
                            ledger=RunLedger(db))
        try:
            outcome = await pipeline.run(
                TaskSpec(url=args.url, schema=schema, instruction=args.instruction))
        except Exception as e:  # 供应商级异常等：可读输出，不裸抛堆栈
            _emit({"error": f"{type(e).__name__}: {e}"})
            return 1

    _emit({
        "status": outcome.status.value,
        "run_id": outcome.run_id,
        "url": outcome.url,
        "provider": outcome.provider,
        "model": outcome.model,
        "input_tokens": outcome.input_tokens,
        "output_tokens": outcome.output_tokens,
        "duration_ms": outcome.duration_ms,
        "error": outcome.error,
        "item": outcome.item.model_dump(mode="json") if outcome.item else None,
    })
    return 0 if outcome.ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="单次采集并结构化提取")
    parser.add_argument("--url", required=True, help="采集目标 URL")
    parser.add_argument("--schema", default="NewsItem",
                        help="models/registry.py 中注册的 Schema 类名")
    parser.add_argument("--instruction", default="从以下网页正文提取资讯信息")
    parser.add_argument("--config", default="config/settings.yaml")
    return asyncio.run(_run(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
