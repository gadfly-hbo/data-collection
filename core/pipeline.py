"""采集流水线主干：fetch → parse → extract → 强类型校验 → 输出。

Phase 1 范围：快照存档、去重闸门与台账写入为桩接口（Phase 2 接入），
任务终态已在 RunOutcome 中按 PLAN.md §5.5 状态机表达，不新造取值。
顺序硬约束（AGENTS.md）：先抓取与正文抽取、过去重闸门，再花 LLM 调用。
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone

from pydantic import BaseModel, ValidationError

from core.dedup import DedupGate
from core.fetcher import FetchStatus, Fetcher
from core.parser import extract_markdown
from core.providers.base import LLMProvider
from core.status import RunStatus  # noqa: F401  再导出，兼容既有导入路径
from storage.ledger import RunLedger
from storage.raw_store import RawStore

_MAX_ERROR_LEN = 160

_RETRY_HINT = (
    "\n\n上一次输出未通过 JSON Schema 校验（{reason}）。"
    "请重新输出一个严格符合 Schema 的 JSON 对象：禁止解释文字、注释与"
    " Markdown 代码块标记。"
)


def _brief(err: Exception, limit: int = _MAX_ERROR_LEN) -> str:
    return " ".join(str(err).split())[:limit]


@dataclass
class TaskSpec:
    url: str
    schema: type[BaseModel]
    instruction: str = ""
    source_id: int | None = None  # 定时任务关联 sources 表；ad-hoc 任务为空
    use_browser: bool = False     # JS 渲染站点走浏览器路径（需安装 playwright）


@dataclass
class RunOutcome:
    status: RunStatus
    url: str
    item: BaseModel | None = None
    raw_hash: str | None = None  # Phase 2：SHA-256 快照哈希
    input_tokens: int = 0
    output_tokens: int = 0
    provider: str = ""
    model: str = ""
    duration_ms: int = 0
    error: str | None = None
    run_id: int | None = None    # 台账写入后回填

    @property
    def ok(self) -> bool:
        """SKIP_* 属按设计跳过，不算失败。"""
        return self.status in (RunStatus.SUCCESS, RunStatus.SKIPPED_UNCHANGED,
                               RunStatus.SKIPPED_NO_CONTENT)


class Pipeline:
    """绑定一对 Fetcher 与 LLMProvider，逐任务执行采集流水线。

    raw_store / dedup / ledger 为可选组件（None = 关闭该环节，供单测使用）；
    生产入口（run_once / run_daemon）必须全部接通——先落快照、过去重
    闸门、再花 LLM 调用的顺序不可颠倒（AGENTS.md 约定），终态全量记台账。
    """

    def __init__(self, fetcher: Fetcher, provider: LLMProvider,
                 raw_store: RawStore | None = None,
                 dedup: DedupGate | None = None,
                 ledger: RunLedger | None = None):
        self.fetcher = fetcher
        self.provider = provider
        self.raw_store = raw_store
        self.dedup = dedup
        self.ledger = ledger

    async def run(self, task: TaskSpec) -> RunOutcome:
        start = time.monotonic()
        outcome = await self._run(task)
        outcome.duration_ms = int((time.monotonic() - start) * 1000)
        if self.ledger is not None:
            outcome.run_id = self.ledger.record(outcome,
                                                schema_type=task.schema.__name__,
                                                source_id=task.source_id)
        return outcome

    async def _run(self, task: TaskSpec) -> RunOutcome:
        fetched = await self.fetcher.fetch(task.url, use_browser=task.use_browser)
        if fetched.status is FetchStatus.BLOCKED:
            return RunOutcome(RunStatus.BLOCKED, task.url, error=fetched.reason)
        if fetched.status is FetchStatus.FETCH_ERROR:
            return RunOutcome(RunStatus.FETCH_ERROR, task.url, error=fetched.reason)
        if fetched.not_modified:
            # 304：进程内条件请求缓存判定内容未变（Phase 2 由哈希闸门跨进程判定）
            return RunOutcome(RunStatus.SKIPPED_UNCHANGED, task.url)

        markdown = extract_markdown(fetched.html or "", url=fetched.url)
        if not markdown:
            return RunOutcome(RunStatus.SKIPPED_NO_CONTENT, task.url)

        # 先落快照、过去重闸门，再花 LLM 调用（顺序不可颠倒）
        raw_hash: str | None = None
        if self.raw_store is not None:
            raw_hash = self.raw_store.save(markdown)
            if self.dedup is not None and self.dedup.seen(task.url, raw_hash):
                return RunOutcome(RunStatus.SKIPPED_UNCHANGED, task.url,
                                  raw_hash=raw_hash)

        try:
            result = await self._extract_with_retry(markdown, task.schema,
                                                    task.instruction)
        except (ValidationError, ValueError) as e:
            return RunOutcome(RunStatus.SCHEMA_ERROR, task.url,
                              error=f"两次提取均未通过校验: {_brief(e)}")
        # TransientProviderError 等供应商级异常向上抛出：T3.1/T3.2 接管退避与降级

        item = _stamp(result.item, fetched.url)
        return RunOutcome(
            RunStatus.SUCCESS, task.url, item=item, raw_hash=raw_hash,
            input_tokens=result.input_tokens, output_tokens=result.output_tokens,
            provider=result.provider, model=result.model,
        )

    async def _extract_with_retry(self, content: str, schema: type[BaseModel],
                                  instruction: str):
        """提取 + 校验；失败后全新调用一次（附失败原因），两次均失败抛最后异常。"""
        last_error: Exception | None = None
        for attempt in range(2):
            instr = instruction
            if attempt > 0 and last_error is not None:
                instr = instruction + _RETRY_HINT.format(reason=_brief(last_error))
            try:
                return await self.provider.extract(content, schema, instruction=instr)
            except (ValidationError, ValueError) as e:
                last_error = e
        raise last_error  # pragma: no cover - 循环必然赋值


def _stamp(item: BaseModel, source_url: str) -> BaseModel:
    """追溯字段以系统为准：LLM 输出中的同名值一律覆盖。"""
    item.source_url = source_url
    item.scraped_at = datetime.now(timezone.utc)
    return item
