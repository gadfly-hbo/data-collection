"""T2.3：去重闸门语义测试（URL + 内容哈希联合判断）。"""
from core.dedup import DedupGate
from storage.db import Database

URL_A = "https://a.example/story"
URL_B = "https://b.example/story"
HASH_1 = "ab" * 32
HASH_2 = "cd" * 32


def _gate() -> DedupGate:
    return DedupGate(Database(":memory:"))


def test_not_seen_initially():
    assert _gate().seen(URL_A, HASH_1) is False


def test_seen_after_successful_run():
    gate = _gate()
    gate._db.insert_run(url=URL_A, status="SUCCESS", raw_hash=HASH_1)
    assert gate.seen(URL_A, HASH_1) is True


def test_failed_extraction_does_not_hit():
    gate = _gate()
    gate._db.insert_run(url=URL_A, status="SCHEMA_ERROR", raw_hash=HASH_1,
                        error_msg="两次提取均未通过校验")
    assert gate.seen(URL_A, HASH_1) is False  # 内容未变也应重试提取


def test_same_url_new_hash_misses():
    gate = _gate()
    gate._db.insert_run(url=URL_A, status="SUCCESS", raw_hash=HASH_1)
    assert gate.seen(URL_A, HASH_2) is False  # 页面有更新，需要重新提取


def test_different_url_same_hash_misses():
    gate = _gate()
    gate._db.insert_run(url=URL_A, status="SUCCESS", raw_hash=HASH_1)
    assert gate.seen(URL_B, HASH_1) is False  # 不同任务不互相干扰
