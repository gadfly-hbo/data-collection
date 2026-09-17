"""T5.3：Web 控制台验收测试（TestClient + FakePipeline，不启动真实调度）。"""
import asyncio
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import run_daemon as rd  # noqa: E402
import webapp  # noqa: E402
from core.pipeline import RunOutcome, RunStatus  # noqa: E402
from storage.db import Database  # noqa: E402
from test_daemon import _FakePipeline  # noqa: E402


def _outcome(status, **kwargs):
    return RunOutcome(status, "https://a.example/1", **kwargs)


@pytest.fixture
def env(tmp_path):
    db = Database(tmp_path / "collector.db")
    sid = db.upsert_source("https://a.example/1", schema_type="NewsItem", name="A")
    run_id = db.insert_run(url="https://a.example/1", status="SUCCESS",
                           source_id=sid, provider="fake", input_tokens=10)
    db.insert_item(run_id=run_id, source_url="https://a.example/1",
                   schema_type="NewsItem",
                   content='{"title": "测试条目", "summary": "s", '
                           '"topics": ["t"], "sentiment": "neutral"}',
                   dedup_hash="ab" * 32)
    pipeline = _FakePipeline(
        outcomes=[_outcome(RunStatus.SUCCESS, run_id=99, input_tokens=5)])
    ctx = rd.DaemonContext(pipeline=pipeline, fetcher=None, budget=None,
                           worker_lock=asyncio.Lock())
    app = webapp.create_app(ctx=ctx, db=db,
                            db_path=tmp_path / "collector.db",
                            with_scheduler=False)
    with TestClient(app) as client:
        yield client, pipeline, db


def test_index_served(env):
    client, _, _ = env
    resp = client.get("/")
    assert resp.status_code == 200
    assert "采集控制台" in resp.text


def test_summary_endpoint(env):
    client, _, _ = env
    data = client.get("/api/summary").json()
    assert data["summary"]["total"] == 1
    assert data["summary"]["today_input_tokens"] == 10


def test_sources_crud(env):
    client, _, _ = env
    rows = client.get("/api/sources").json()
    assert len(rows) == 1 and rows[0]["last_status"] == "SUCCESS"

    resp = client.post("/api/sources", json={
        "url": "https://new.example", "schema_type": "NewsItem", "interval_s": 60})
    assert resp.json()["ok"] is True
    assert len(client.get("/api/sources").json()) == 2

    # 非法输入：URL / schema_type（db 层 validate_source 统一拒绝）
    assert client.post("/api/sources", json={
        "url": "bad", "schema_type": "NewsItem"}).status_code == 400
    assert client.post("/api/sources", json={
        "url": "https://x.example", "schema_type": "Nope"}).status_code == 400

    # 同 URL 再提交 → 更新而非新增
    resp = client.post("/api/sources", json={
        "url": "https://new.example", "schema_type": "NewsItem"})
    assert resp.status_code == 200
    assert len(client.get("/api/sources").json()) == 2


def test_source_delete_fk_conflict_and_404(env):
    client, _, _ = env
    rows = client.get("/api/sources").json()
    resp = client.delete(f"/api/sources/{rows[0]['id']}")
    assert resp.status_code == 409          # 有关联台账：不可删除
    assert "停用" in resp.json()["detail"]
    assert client.delete("/api/sources/999").status_code == 404


def test_run_by_source_id(env):
    client, pipeline, _ = env
    body = client.post("/api/run", json={"source_id": 1}).json()
    assert body["ok"] is True and body["status"] == "SUCCESS"
    assert body["run_id"] == 99
    assert pipeline.calls[0].source_id == 1


def test_run_adhoc_url(env):
    client, pipeline, _ = env
    body = client.post("/api/run", json={"url": "https://ad.example/x"}).json()
    assert body["ok"] is True
    assert pipeline.calls[-1].url == "https://ad.example/x"
    assert pipeline.calls[-1].source_id is None
    assert pipeline.calls[-1].use_browser is False


def test_run_unknown_schema_rejected(env):
    client, pipeline, _ = env
    resp = client.post("/api/run", json={"url": "https://x.example",
                                         "schema_type": "Nope"})
    assert resp.status_code == 400
    assert pipeline.calls == []


def test_run_missing_body(env):
    client, _, _ = env
    assert client.post("/api/run", json={}).status_code == 422


def test_items_and_runs(env):
    client, _, _ = env
    data = client.get("/api/items").json()
    assert data["total"] == 1
    assert data["items"][0]["item"]["title"] == "测试条目"
    runs = client.get("/api/runs").json()
    assert runs and runs[0]["status"] == "SUCCESS"


def test_export_download(env):
    client, _, _ = env
    resp = client.get("/api/export?format=csv")
    assert resp.status_code == 200
    assert "attachment" in resp.headers["content-disposition"]
    resp = client.get("/api/export?format=xml")
    assert resp.status_code == 400
