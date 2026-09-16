"""T2.1：快照存储验收测试。"""
import hashlib

from storage.raw_store import RawStore


def test_save_returns_hash_matching_filename(tmp_path):
    store = RawStore(tmp_path / "raw")
    digest = store.save("第一份快照内容")
    assert len(digest) == 64 and int(digest, 16) >= 0          # 合法 SHA-256 hex
    assert digest == hashlib.sha256("第一份快照内容".encode()).hexdigest()
    assert (tmp_path / "raw" / f"{digest}.md").exists()
    assert store.exists(digest)


def test_read_roundtrip_matches_written_content(tmp_path):
    store = RawStore(tmp_path / "raw")
    digest = store.save("中文内容 with unicode ✓")
    assert store.read(digest) == "中文内容 with unicode ✓"


def test_same_content_written_twice_yields_one_file(tmp_path):
    store = RawStore(tmp_path / "raw")
    d1 = store.save("重复内容")
    d2 = store.save("重复内容")
    assert d1 == d2
    assert len(list((tmp_path / "raw").glob("*.md"))) == 1


def test_different_contents_yield_distinct_files(tmp_path):
    store = RawStore(tmp_path / "raw")
    d1 = store.save("内容 A")
    d2 = store.save("内容 B")
    assert d1 != d2
    assert len(list((tmp_path / "raw").glob("*.md"))) == 2
