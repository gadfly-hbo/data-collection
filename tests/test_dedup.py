"""T2.3 + P2-5：去重闸门语义测试（URL + 内容哈希 + Schema 联合判断）。"""
from core.dedup import DedupGate
from storage.db import Database

URL_A = "https://a.example/story"
URL_B = "https://b.example/story"
HASH_1 = "ab" * 32
HASH_2 = "cd" * 32


def _gate() -> DedupGate:
    return DedupGate(Database(":memory:"))


def _record_success(gate: DedupGate, url: str, raw_hash: str,
                    schema_type: str = "NewsItem") -> None:
    run_id = gate._db.insert_run(url=url, status="SUCCESS", raw_hash=raw_hash)
    gate._db.insert_item(run_id=run_id, source_url=url, schema_type=schema_type,
                         content='{"title": "t"}',
                         dedup_hash=f"{raw_hash[:30]}{schema_type}")


def test_not_seen_initially():
    assert _gate().seen(URL_A, HASH_1, "NewsItem") is False


def test_seen_after_successful_run():
    gate = _gate()
    _record_success(gate, URL_A, HASH_1)
    assert gate.seen(URL_A, HASH_1, "NewsItem") is True


def test_failed_extraction_does_not_hit():
    gate = _gate()
    gate._db.insert_run(url=URL_A, status="SCHEMA_ERROR", raw_hash=HASH_1,
                        error_msg="两次提取均未通过校验", input_tokens=80)
    assert gate.seen(URL_A, HASH_1, "NewsItem") is False  # 内容未变也应重试提取


def test_same_url_new_hash_misses():
    gate = _gate()
    _record_success(gate, URL_A, HASH_1)
    assert gate.seen(URL_A, HASH_2, "NewsItem") is False  # 页面有更新，需要重新提取


def test_different_url_same_hash_misses():
    gate = _gate()
    _record_success(gate, URL_A, HASH_1)
    assert gate.seen(URL_B, HASH_1, "NewsItem") is False  # 不同任务不互相干扰


def test_schema_change_bypasses_dedup():
    gate = _gate()
    _record_success(gate, URL_A, HASH_1, schema_type="NewsItem")
    # 同 URL 同内容但改配了 Schema → 必须按新 Schema 重新提取（P2-5）
    assert gate.seen(URL_A, HASH_1, "CompetitorEvent") is False
