"""任务终态台账：所有终态写 crawl_runs，成功路径写 extracted_items。

没有记台账的任务等于没跑（AGENTS.md 硬性规则）。
"""
from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING

from core.status import RunStatus
from storage.db import Database

if TYPE_CHECKING:
    from core.pipeline import RunOutcome


def content_dedup_hash(schema_type: str, item) -> str:
    """内容去重哈希：排除追溯性易变字段（scraped_at / source_url）后规范化序列化。"""
    payload = item.model_dump(mode="json")
    payload.pop("scraped_at", None)
    payload.pop("source_url", None)
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(f"{schema_type}:{canonical}".encode("utf-8")).hexdigest()


class RunLedger:
    def __init__(self, db: Database):
        self._db = db

    def record(self, outcome: "RunOutcome", schema_type: str,
               source_id: int | None = None) -> int:
        """写入一条终态台账，返回 run_id；SUCCESS 额外尝试写入 extracted_items。"""
        run_id = self._db.insert_run(
            url=outcome.url, status=outcome.status.value, source_id=source_id,
            raw_hash=outcome.raw_hash, provider=outcome.provider or None,
            model=outcome.model or None, input_tokens=outcome.input_tokens,
            output_tokens=outcome.output_tokens, duration_ms=outcome.duration_ms,
            error_msg=outcome.error,
        )
        if outcome.status is RunStatus.SUCCESS and outcome.item is not None:
            item = outcome.item
            self._db.insert_item(
                run_id=run_id, source_url=item.source_url or outcome.url,
                schema_type=schema_type, content=item.model_dump_json(),
                dedup_hash=content_dedup_hash(schema_type, item),
            )
        return run_id
