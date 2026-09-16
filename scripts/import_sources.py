"""一次性迁移：sources.yaml → sources 表（幂等，UNIQUE url 冲突即更新）。

迁移后 sources 表为来源配置的单一事实源（T5.2）；
守护进程按 tick 读取表内配置，sources.yaml 保留作初始导入模板。
"""
from __future__ import annotations

import argparse
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from core.dotenv import load_dotenv

load_dotenv()

import yaml  # noqa: E402

from storage.db import Database  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]


def import_yaml_sources(db: Database, yaml_path: pathlib.Path) -> int:
    data = yaml.safe_load(pathlib.Path(yaml_path).read_text())
    count = 0
    for src in data.get("sources", []):
        db.upsert_source(
            url=src["url"], schema_type=src["schema_type"], name=src.get("name"),
            interval_s=int(src.get("interval_s", 3600)),
            enabled=bool(src.get("enabled", True)),
            use_browser=bool(src.get("use_browser", False)),
            instruction=src.get("instruction") or "")
        count += 1
    return count


def main() -> int:
    parser = argparse.ArgumentParser(description="迁移 sources.yaml → sources 表（幂等）")
    parser.add_argument("--sources", default="config/sources.yaml")
    parser.add_argument("--db", default=str(REPO_ROOT / "data" / "collector.db"))
    args = parser.parse_args()

    db = Database(args.db)
    try:
        count = import_yaml_sources(db, REPO_ROOT / args.sources)
        total = db.conn.execute("SELECT COUNT(*) AS n FROM sources").fetchone()["n"]
    finally:
        db.close()
    print(f"已导入 {count} 个来源；sources 表现有 {total} 条")
    return 0


if __name__ == "__main__":
    sys.exit(main())
