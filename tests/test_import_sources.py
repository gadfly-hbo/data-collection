"""T5.2：sources.yaml → sources 表迁移（幂等）验收测试。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from import_sources import import_yaml_sources  # noqa: E402
from storage.db import Database  # noqa: E402

YAML_V1 = """\
sources:
  - {name: A, url: 'https://a.example/1', schema_type: NewsItem, interval_s: 3600, enabled: true}
  - {name: B, url: 'https://b.example/2', schema_type: NewsItem, interval_s: 7200, enabled: false}
"""
YAML_V2 = """\
sources:
  - {name: A-renamed, url: 'https://a.example/1', schema_type: NewsItem, interval_s: 120, enabled: true}
  - {name: B, url: 'https://b.example/2', schema_type: NewsItem, interval_s: 7200, enabled: false}
"""


def _write(tmp_path, text):
    p = tmp_path / "sources.yaml"
    p.write_text(text, encoding="utf-8")
    return p


def test_import_is_idempotent(tmp_path):
    db = Database(":memory:")
    yaml_path = _write(tmp_path, YAML_V1)
    assert import_yaml_sources(db, yaml_path) == 2
    assert import_yaml_sources(db, yaml_path) == 2  # 重复执行不新增
    rows = db.conn.execute("SELECT * FROM sources ORDER BY id").fetchall()
    assert len(rows) == 2
    assert rows[0]["name"] == "A" and rows[1]["enabled"] == 0


def test_rerun_updates_changed_config_in_place(tmp_path):
    db = Database(":memory:")
    first = _write(tmp_path, YAML_V1)
    import_yaml_sources(db, first)
    id_before = db.get_source("https://a.example/1")["id"]

    second = _write(tmp_path, YAML_V2)
    import_yaml_sources(db, second)

    rows = db.conn.execute("SELECT * FROM sources ORDER BY id").fetchall()
    assert len(rows) == 2  # 不新增行
    a = db.get_source("https://a.example/1")
    assert a["id"] == id_before            # 同一来源保持同 id
    assert a["name"] == "A-renamed" and a["interval_s"] == 120  # 配置已更新
