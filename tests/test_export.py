"""T4.1：导出工具验收测试。"""
import csv
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import export_data as ed  # noqa: E402
from models.registry import get_schema  # noqa: E402
from storage.db import Database  # noqa: E402

def _news_json(url: str) -> str:
    return json.dumps({
        "title": "中文标题测试", "summary": "摘要内容", "topics": ["AI", "监管"],
        "sentiment": "neutral", "source_url": url,
    }, ensure_ascii=False)
EVENT_JSON = json.dumps({
    "company": "Acme", "event_type": "funding", "headline": "完成融资",
    "detail": "2 亿美元", "impact_level": "high",
    "source_url": "https://b.example/event",
}, ensure_ascii=False)


def _seed_db(tmp_path) -> Path:
    db = Database(tmp_path / "collector.db")
    seeds = [
        ("https://a.example/0", "2026-09-10 08:00:00", "ab" * 32),
        ("https://a.example/1", "2026-09-15 09:00:00", "ac" * 32),
        ("https://b.example/event", "2026-09-16 10:00:00", "ad" * 32),
    ]
    for url, day, dedup in seeds:
        schema_type = "CompetitorEvent" if "event" in url else "NewsItem"
        content = EVENT_JSON if schema_type == "CompetitorEvent" else _news_json(url)
        run_id = db.insert_run(url=url, status="SUCCESS")
        item_id = db.insert_item(run_id=run_id, source_url=url,
                                 schema_type=schema_type, content=content,
                                 dedup_hash=dedup)
        db.conn.execute("UPDATE extracted_items SET created_at = ? WHERE id = ?",
                        (day, item_id))
    db.conn.commit()
    db.close()
    return tmp_path / "collector.db"


def test_fetch_rows_and_filters(tmp_path):
    db_path = _seed_db(tmp_path)
    assert len(ed.fetch_rows(db_path)) == 3
    news = ed.fetch_rows(db_path, schema_type="NewsItem")
    assert len(news) == 2 and all(r["schema_type"] == "NewsItem" for r in news)
    recent = ed.fetch_rows(db_path, since="2026-09-15")
    assert len(recent) == 2  # 9-15 与 9-16 各一条
    old = ed.fetch_rows(db_path, until="2026-09-10")
    assert len(old) == 1


def test_json_export_round_trips_through_pydantic(tmp_path):
    db_path = _seed_db(tmp_path)
    rows = ed.fetch_rows(db_path)
    payload = json.loads(ed.to_json(rows))
    assert payload["count"] == 3
    for row in payload["items"]:
        schema = get_schema(row["schema_type"])
        item = schema.model_validate_json(json.dumps(row["item"], ensure_ascii=False))
        assert item.source_url == row["source_url"]


def test_csv_export_bom_and_chinese_intact(tmp_path):
    db_path = _seed_db(tmp_path)
    text = ed.to_csv(ed.fetch_rows(db_path))
    assert text.startswith("\ufeff")                       # BOM（Excel 中文不乱码）
    assert "中文标题测试" in text
    reader = csv.reader(io.StringIO(text.lstrip("\ufeff"), newline=""))
    header = next(reader)
    assert header[:5] == ed._META_FIELDS
    assert "title" in header and "topics" in header
    body = list(reader)
    assert len(body) == 3


def test_markdown_export_contains_titles(tmp_path):
    db_path = _seed_db(tmp_path)
    md = ed.to_markdown(ed.fetch_rows(db_path))
    assert "中文标题测试" in md
    assert "完成融资" in md
    assert "https://a.example/1" in md
