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


class BrowserUnavailable(Exception):
    """playwright 未安装或浏览器驱动未就绪。"""


_BROWSER_TIMEOUT_MS = 30_000


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
        # 浏览器渲染路径（lazy 初始化，实例跨任务复用）
        self._playwright = None
        self._browser = None
        self._page = None

    async def __aenter__(self) -> "Fetcher":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        for resource, closer in ((self._page, "close"), (self._browser, "close"),
                                 (self._playwright, "stop")):
            if resource is not None:
                try:
                    await getattr(resource, closer)()
                except Exception:
                    pass
        self._page = self._browser = self._playwright = None
        await self._client.aclose()

    async def fetch(self, url: str, *, use_browser: bool = False) -> FetchResult:
        try:
            host = httpx.URL(url).host
        except (httpx.InvalidURL, ValueError) as e:
            return FetchResult(status=FetchStatus.FETCH_ERROR, url=url,
                               reason=f"非法 URL: {e}")
        if not host:
            return FetchResult(status=FetchStatus.FETCH_ERROR, url=url,
                               reason="非法 URL: 缺少 host")

        if self._respect_robots:
            try:
                robots = await self._robots_for(url)
            except _RobotsUnreachable as e:
                return FetchResult(status=FetchStatus.FETCH_ERROR, url=url,
                                   reason=f"robots.txt 不可达: {e}")
            if robots is not None and not robots.can_fetch(self._ua, url):
                return FetchResult(status=FetchStatus.BLOCKED, url=url,
                                   reason="robots.txt disallow")

        await self._pace(host)

        if use_browser:  # JS 渲染站点：robots 与限速已前置执行
            return await self._fetch_with_browser(url)

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
        """同域名请求保持最小间隔（在途串行由单 Worker 结构保证）。"""
        lock = self._host_locks.setdefault(host, asyncio.Lock())
        async with lock:
            last = self._last_hit.get(host)
            if last is not None:
                remaining = self._min_interval - (time.monotonic() - last)
                if remaining > 0:
                    await self._sleep(remaining)
            self._last_hit[host] = time.monotonic()

    def discard_validators(self, url: str) -> None:
        """任务失败后丢弃条件请求验证器（P1-2）：下次对该 URL 全量重抓，
        防止 304 短路把失败内容的重试永久标记为 UNCHANGED。"""
        self._validators.pop(url, None)

    async def _sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)

    # ---------- 浏览器渲染路径（JS 渲染 / SPA 站点，可选） ----------

    def _load_playwright(self):
        try:
            from playwright.async_api import async_playwright
        except ImportError as e:
            raise BrowserUnavailable(
                "未安装 playwright：pip install playwright && playwright install chromium") from e
        return async_playwright

    async def _ensure_page(self):
        if self._page is None:
            async_playwright = self._load_playwright()
            playwright = await async_playwright().start()
            try:
                self._browser = await playwright.chromium.launch(headless=True)
                self._page = await self._browser.new_page(user_agent=self._ua)
            except Exception:
                # 启动失败回滚已启动的资源，避免残留实例泄漏
                try:
                    if self._browser is not None:
                        await self._browser.close()
                    await playwright.stop()
                except Exception:
                    pass
                self._browser = None
                self._playwright = None
                raise
        return self._page

    async def _fetch_with_browser(self, url: str) -> FetchResult:
        """真实浏览器渲染后取 DOM；条件请求缓存不适用于该路径。"""
        try:
            page = await self._ensure_page()
            resp = await page.goto(url, wait_until="domcontentloaded",
                                   timeout=_BROWSER_TIMEOUT_MS)
            status = resp.status if resp is not None else None
            html = await page.content()
        except BrowserUnavailable as e:
            return FetchResult(status=FetchStatus.FETCH_ERROR, url=url, reason=str(e))
        except Exception as e:  # playwright 异常类型随版本变化，统一按传输错误归类
            return FetchResult(status=FetchStatus.FETCH_ERROR, url=url, reason=str(e))

        if status is not None and status in _BLOCKED_CODES:
            return FetchResult(status=FetchStatus.BLOCKED, url=url, status_code=status,
                               reason=f"目标站拒绝访问（{status}）")
        if status is not None and status >= 400:
            return FetchResult(status=FetchStatus.FETCH_ERROR, url=url,
                               status_code=status, reason=f"HTTP {status}")
        return FetchResult(status=FetchStatus.OK, url=url, html=html, status_code=status)
