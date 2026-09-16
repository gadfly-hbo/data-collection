"""导出结构化数据为 CSV / JSON / Markdown。

用法：
  python scripts/export_data.py --format json
  python scripts/export_data.py --format csv --schema-type NewsItem --since 2026-09-01 --out out.csv

只读打开数据库（mode=ro），不影响在跑的采集。
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import pathlib
import sqlite3
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from core.dotenv import load_dotenv

load_dotenv()

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
_META_FIELDS = ["id", "run_id", "source_url", "schema_type", "created_at"]


def fetch_rows(db_path: pathlib.Path, schema_type: str | None = None,
               since: str | None = None, until: str | None = None) -> list[dict]:
    """从 extracted_items 读取并解析 content；数据库只读打开。"""
    if not db_path.exists():
        raise FileNotFoundError(f"数据库不存在：{db_path}（先运行 run_once / run_daemon）")
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        sql = ("SELECT id, run_id, source_url, schema_type, content, created_at "
               "FROM extracted_items WHERE 1 = 1")
        params: list = []
        if schema_type:
            sql += " AND schema_type = ?"
            params.append(schema_type)
        if since:
            sql += " AND date(created_at) >= date(?)"
            params.append(since)
        if until:
            sql += " AND date(created_at) <= date(?)"
            params.append(until)
        sql += " ORDER BY id"
        return [{"id": r["id"], "run_id": r["run_id"], "source_url": r["source_url"],
                 "schema_type": r["schema_type"], "created_at": r["created_at"],
                 "item": json.loads(r["content"])}
                for r in conn.execute(sql, params)]
    finally:
        conn.close()


def to_json(rows: list[dict]) -> str:
    return json.dumps({"count": len(rows), "items": rows},
                      ensure_ascii=False, indent=2)


def to_csv(rows: list[dict]) -> str:
    """元数据列 + item 字段并集；嵌套值序列化为 JSON 字符串。"""
    item_keys: list[str] = []
    for row in rows:
        for key in row["item"]:
            if key not in item_keys:
                item_keys.append(key)
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(_META_FIELDS + item_keys)
    for row in rows:
        meta = [row[f] for f in _META_FIELDS]
        cells = []
        for key in item_keys:
            value = row["item"].get(key)
            if isinstance(value, (list, dict)):
                value = json.dumps(value, ensure_ascii=False)
            cells.append(value)
        writer.writerow(meta + cells)
    # utf-8-sig BOM：Excel 打开中文不乱码
    return "\ufeff" + buf.getvalue()


def to_markdown(rows: list[dict]) -> str:
    lines: list[str] = [f"# 采集数据导出（{len(rows)} 条）", ""]
    for row in rows:
        item = row["item"]
        title = item.get("title") or item.get("headline") or f"条目 #{row['id']}"
        lines.append(f"## {title}")
        lines.append(f"- 来源：{row['source_url']}")
        lines.append(f"- 类型：{row['schema_type']}｜采集时间：{row['created_at']}")
        for key, value in item.items():
            if key in ("title", "headline"):
                continue
            if isinstance(value, (list, dict)):
                value = json.dumps(value, ensure_ascii=False)
            lines.append(f"- {key}：{value}")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="导出 extracted_items 为 CSV/JSON/Markdown")
    parser.add_argument("--format", choices=["csv", "json", "markdown"], default="json")
    parser.add_argument("--schema-type", default=None, help="按 Schema 类名过滤")
    parser.add_argument("--since", default=None, help="起始日期 YYYY-MM-DD（含）")
    parser.add_argument("--until", default=None, help="结束日期 YYYY-MM-DD（含）")
    parser.add_argument("--db", default=str(REPO_ROOT / "data" / "collector.db"))
    parser.add_argument("--out", default=None, help="输出文件路径（默认 stdout）")
    args = parser.parse_args()

    try:
        rows = fetch_rows(pathlib.Path(args.db), args.schema_type, args.since, args.until)
    except (FileNotFoundError, sqlite3.OperationalError, json.JSONDecodeError) as e:
        print(f"导出失败：{e}", file=sys.stderr)
        return 2

    output = {"csv": to_csv, "json": to_json, "markdown": to_markdown}[args.format](rows)
    if args.out:
        out = pathlib.Path(args.out)
        if args.format == "csv":
            out.write_text(output, encoding="utf-8")  # 已含 BOM 字符
        else:
            out.write_text(output, encoding="utf-8")
        print(f"已导出 {len(rows)} 条 → {out}", file=sys.stderr)
    else:
        sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
