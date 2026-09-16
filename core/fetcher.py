"""抓取器：httpx 异步拉取 + robots 合规 + 同域名限速 + 条件请求。

对目标站点的所有 HTTP 请求必须经由本模块（AGENTS.md 硬性规则）。
"""
from __future__ import annotations

import asyncio
import time
import urllib.robotparser
from dataclasses import dataclass
from enum import Enum

import httpx


class FetchStatus(str, Enum):
    OK = "OK"
    BLOCKED = "BLOCKED"
    FETCH_ERROR = "FETCH_ERROR"


@dataclass
class FetchResult:
    status: FetchStatus
    url: str
    html: str | None = None
    status_code: int | None = None
    # 304 短路：内容未变，pipeline 据此映射为 SKIPPED_UNCHANGED（不新造状态值）
    not_modified: bool = False
    reason: str | None = None


# 目标站明确拒绝：robots 之外的封锁信号，后续可按站点升级 Playwright 或告警
_BLOCKED_CODES = {401, 403, 429}


class _RobotsUnreachable(Exception):
    """robots.txt 网络层不可达（区别于 5xx 响应）。"""


class Fetcher:
    def __init__(
        self,
        user_agent: str,
        min_interval_per_host_s: float = 5.0,
        respect_robots: bool = True,
        timeout_s: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            headers={"User-Agent": user_agent},
            timeout=httpx.Timeout(timeout_s),
            follow_redirects=True,
            transport=transport,
        )
        self._ua = user_agent
        self._min_interval = min_interval_per_host_s
        self._respect_robots = respect_robots
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self._host_locks: dict[str, asyncio.Lock] = {}
        self._last_hit: dict[str, float] = {}
        # url → (etag, last_modified)，进程内缓存；持久化随 Phase 2 存储层落地
        self._validators: dict[str, tuple[str | None, str | None]] = {}

    async def __aenter__(self) -> "Fetcher":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def fetch(self, url: str) -> FetchResult:
        if self._respect_robots:
            try:
                robots = await self._robots_for(url)
            except _RobotsUnreachable as e:
                return FetchResult(status=FetchStatus.FETCH_ERROR, url=url,
                                   reason=f"robots.txt 不可达: {e}")
            if robots is not None and not robots.can_fetch(self._ua, url):
                return FetchResult(status=FetchStatus.BLOCKED, url=url,
                                   reason="robots.txt disallow")

        await self._pace(httpx.URL(url).host)

        headers: dict[str, str] = {}
        etag, last_modified = self._validators.get(url, (None, None))
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified

        try:
            resp = await self._client.get(url, headers=headers)
        except httpx.HTTPError as e:  # 超时、连接失败等传输层错误
            return FetchResult(status=FetchStatus.FETCH_ERROR, url=url, reason=str(e))

        if resp.status_code == httpx.codes.NOT_MODIFIED:
            return FetchResult(status=FetchStatus.OK, url=url, status_code=304,
                               not_modified=True)
        if resp.status_code in _BLOCKED_CODES:
            return FetchResult(status=FetchStatus.BLOCKED, url=url,
                               status_code=resp.status_code,
                               reason=f"目标站拒绝访问（{resp.status_code}）")
        if resp.status_code >= 400:
            return FetchResult(status=FetchStatus.FETCH_ERROR, url=url,
                               status_code=resp.status_code,
                               reason=f"HTTP {resp.status_code}")

        self._validators[url] = (resp.headers.get("ETag"),
                                 resp.headers.get("Last-Modified"))
        return FetchResult(status=FetchStatus.OK, url=str(resp.url), html=resp.text,
                           status_code=resp.status_code)

    async def _robots_for(self, url: str) -> urllib.robotparser.RobotFileParser | None:
        """按域名加载并缓存 robots.txt；None 表示站点未声明（允许抓取）。"""
        parsed = httpx.URL(url)
        host = parsed.host
        if host in self._robots:
            return self._robots[host]

        robots_url = str(parsed.copy_with(path="/robots.txt", query=None, fragment=None))
        try:
            resp = await self._client.get(robots_url)
        except httpx.HTTPError as e:
            # 不缓存，网络恢复后下次重试
            raise _RobotsUnreachable(str(e)) from e

        if resp.status_code >= 500:
            # RFC 9309：robots 不可达（5xx）期间按全站禁止处理；不缓存以便恢复后重试
            parser = urllib.robotparser.RobotFileParser()
            parser.parse(["User-agent: *", "Disallow: /"])
            return parser

        parser: urllib.robotparser.RobotFileParser | None
        if resp.status_code >= 400:  # 404 等：站点未声明 robots，允许
            parser = None
        else:
            parser = urllib.robotparser.RobotFileParser()
            parser.parse(resp.text.splitlines())
        self._robots[host] = parser
        return parser

    async def _pace(self, host: str) -> None:
        """同域名串行且保持最小间隔，避免触发目标站风控。"""
        lock = self._host_locks.setdefault(host, asyncio.Lock())
        async with lock:
            last = self._last_hit.get(host)
            if last is not None:
                remaining = self._min_interval - (time.monotonic() - last)
                if remaining > 0:
                    await self._sleep(remaining)
            self._last_hit[host] = time.monotonic()

    async def _sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)
