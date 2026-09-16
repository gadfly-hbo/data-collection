"""T1.3 + T4.3：Fetcher 验收测试（robots 三分支、限速、状态分类、条件请求、浏览器路径）。"""
import pytest
import httpx

from core.fetcher import BrowserUnavailable, FetchStatus, Fetcher

UA = "TestBot/1.0"


def _robots_ok() -> str:
    return "User-agent: *\nDisallow:\n"  # 空 Disallow = 允许全站


async def _run_fetcher(transport, *fetch_urls, **kwargs):
    async with Fetcher(UA, transport=transport, **kwargs) as f:
        return [await f.fetch(u) for u in fetch_urls]


async def test_robots_allow_fetches_page():
    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            return httpx.Response(200, text=_robots_ok())
        return httpx.Response(200, text="<html><body>hello</body></html>")

    (result,) = await _run_fetcher(httpx.MockTransport(handle),
                                   "https://a.example/page")
    assert result.status is FetchStatus.OK
    assert result.html and "hello" in result.html
    assert result.status_code == 200


async def test_robots_disallow_blocks_before_page_request():
    page_hits: list[str] = []

    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            return httpx.Response(200, text="User-agent: *\nDisallow: /\n")
        page_hits.append(str(request.url))
        return httpx.Response(200, text="x")

    (result,) = await _run_fetcher(httpx.MockTransport(handle),
                                   "https://deny.example/post")
    assert result.status is FetchStatus.BLOCKED
    assert result.reason and "robots" in result.reason
    assert page_hits == []  # 被拒时不得发出页面请求


async def test_robots_missing_404_allows():
    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            return httpx.Response(404)
        return httpx.Response(200, text="<html><body>ok</body></html>")

    (result,) = await _run_fetcher(httpx.MockTransport(handle),
                                   "https://b.example/page")
    assert result.status is FetchStatus.OK


async def test_robots_5xx_disallows_all():
    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            return httpx.Response(503)
        raise AssertionError("robots 5xx 时不应发出页面请求")

    (result,) = await _run_fetcher(httpx.MockTransport(handle),
                                   "https://c.example/page")
    assert result.status is FetchStatus.BLOCKED


async def test_robots_unreachable_is_fetch_error():
    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            raise httpx.ConnectError("boom")
        raise AssertionError("robots 不可达时不应发出页面请求")

    (result,) = await _run_fetcher(httpx.MockTransport(handle),
                                   "https://d.example/page")
    assert result.status is FetchStatus.FETCH_ERROR
    assert result.reason and "robots" in result.reason


async def test_min_interval_enforced_per_host(monkeypatch):
    slept: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        slept.append(seconds)

    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            return httpx.Response(404)
        return httpx.Response(200, text="x")

    async with Fetcher(UA, min_interval_per_host_s=5.0,
                       transport=httpx.MockTransport(handle)) as f:
        monkeypatch.setattr(f, "_sleep", fake_sleep)
        await f.fetch("https://a.example/1")
        await f.fetch("https://a.example/2")
        await f.fetch("https://b.example/1")

    assert len(slept) == 1          # 只有同域名的第二次请求被限速
    assert slept[0] > 4.5           # 间隔 ≥ 配置值（扣除时钟误差）


@pytest.mark.parametrize("code,expected", [
    (403, FetchStatus.BLOCKED),
    (429, FetchStatus.BLOCKED),
    (401, FetchStatus.BLOCKED),
    (500, FetchStatus.FETCH_ERROR),
    (503, FetchStatus.FETCH_ERROR),
    (404, FetchStatus.FETCH_ERROR),
])
async def test_status_classification(code, expected):
    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            return httpx.Response(404)
        return httpx.Response(code)

    (result,) = await _run_fetcher(httpx.MockTransport(handle),
                                   f"https://s.example/doc{code}")
    assert result.status is expected


async def test_timeout_is_fetch_error():
    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            return httpx.Response(404)
        raise httpx.ConnectTimeout("connect timed out")

    (result,) = await _run_fetcher(httpx.MockTransport(handle),
                                   "https://t.example/slow")
    assert result.status is FetchStatus.FETCH_ERROR


async def test_conditional_request_304_short_circuit():
    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            return httpx.Response(404)
        if request.headers.get("if-none-match") == '"v1"':
            return httpx.Response(304)
        return httpx.Response(200, text="<html><body>v1</body></html>",
                              headers={"ETag": '"v1"'})

    first, second = await _run_fetcher(
        httpx.MockTransport(handle), "https://e.example/doc", "https://e.example/doc",
        min_interval_per_host_s=0)
    assert first.status is FetchStatus.OK and first.html
    assert second.not_modified and second.html is None


async def test_redirect_followed():
    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            return httpx.Response(404)
        if request.url.path == "/old":
            return httpx.Response(301, headers={"Location": "https://f.example/new"})
        return httpx.Response(200, text="<html><body>new</body></html>")

    (result,) = await _run_fetcher(httpx.MockTransport(handle),
                                   "https://f.example/old")
    assert result.status is FetchStatus.OK
    assert result.url == "https://f.example/new"
    assert result.html and "new" in result.html


async def test_browser_unavailable_is_fetch_error(monkeypatch):
    def no_playwright(self):
        raise BrowserUnavailable("未安装 playwright：pip install playwright")

    monkeypatch.setattr(Fetcher, "_load_playwright", no_playwright)

    async def handle(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/robots.txt"):
            return httpx.Response(404)
        raise AssertionError("浏览器路径不应发 httpx 页面请求")

    async with Fetcher(UA, transport=httpx.MockTransport(handle)) as f:
        result = await f.fetch("https://g.example/page", use_browser=True)
    assert result.status is FetchStatus.FETCH_ERROR
    assert result.reason and "playwright" in result.reason


def _playwright_installed() -> bool:
    try:
        import playwright  # noqa: F401
        return True
    except ImportError:
        return False


@pytest.mark.live
@pytest.mark.skipif(not _playwright_installed(),
                    reason="需要 playwright + chromium（pip install playwright && playwright install chromium）")
async def test_js_site_renders_via_browser_live():
    """静态路径抽不出正文（JS 渲染页），浏览器路径拿到渲染后 DOM。"""
    from core.parser import extract_markdown

    url = "https://quotes.toscrape.com/js/"
    async with Fetcher(
        "DataCollectorBot/0.1 (live smoke; contact: you@example.com)",
        min_interval_per_host_s=0,
    ) as f:
        static = await f.fetch(url)
        rendered = await f.fetch(url, use_browser=True)

    assert static.status is FetchStatus.OK
    assert rendered.status is FetchStatus.OK, rendered.reason
    static_md = extract_markdown(static.html or "", url=url)
    rendered_md = extract_markdown(rendered.html or "", url=url)
    assert rendered_md and len(rendered_md) > 200, "浏览器路径应拿到渲染后正文"
    assert not static_md or len(static_md) * 2 < len(rendered_md), \
        "静态路径的正文应显著少于渲染后（JS 渲染站点）"


@pytest.mark.live
async def test_fetch_hn_live():
    async with Fetcher(
        "DataCollectorBot/0.1 (live smoke; contact: you@example.com)",
        min_interval_per_host_s=0,
    ) as f:
        result = await f.fetch("https://news.ycombinator.com")
    assert result.status is FetchStatus.OK, f"{result.status}: {result.reason}"
    assert result.html and "<html" in result.html.lower()
