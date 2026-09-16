"""T4.2：OpenAICompatProvider 验收测试（mock 客户端，不打真实 API）。"""
import json
import os

import pytest
from pydantic import ValidationError

from core.providers.base import TransientProviderError
from core.providers.factory import create_provider_stack
from core.providers.openai_compat import OpenAICompatProvider
from models.news_schema import NewsItem

NEWS_JSON = json.dumps({
    "title": "Acme 发布新一代数据平台", "summary": "完成 C 轮融资。",
    "topics": ["数据平台"], "sentiment": "positive",
}, ensure_ascii=False)


class _FakeMessage:
    def __init__(self, content: str | None):
        self.content = content


class _FakeChoice:
    def __init__(self, message: _FakeMessage):
        self.message = message


class _FakeUsage:
    def __init__(self, prompt: int, completion: int):
        self.prompt_tokens = prompt
        self.completion_tokens = completion


class _FakeResp:
    def __init__(self, content: str | None, usage: _FakeUsage | None = None):
        self.choices = [_FakeChoice(_FakeMessage(content))]
        self.usage = usage if usage is not None else _FakeUsage(80, 30)


class _FakeCompletions:
    def __init__(self, resp=None, error=None):
        self.resp = resp
        self.error = error
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.resp


class _FakeClient:
    def __init__(self, resp=None, error=None):
        self.chat = type("Chat", (), {})()
        self.chat.completions = _FakeCompletions(resp, error)


class _FakeStatusError(Exception):
    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.status_code = status_code


def _provider(resp=None, error=None, **kwargs) -> OpenAICompatProvider:
    return OpenAICompatProvider(model="deepseek-chat",
                                client=_FakeClient(resp, error), **kwargs)


async def test_extract_sends_schema_and_parses():
    p = _provider(resp=_FakeResp(NEWS_JSON))
    result = await p.extract("正文内容", NewsItem, instruction="提取资讯")

    assert result.item.title.startswith("Acme")
    assert (result.input_tokens, result.output_tokens) == (80, 30)
    assert result.provider == "openai-compat"

    call = p.client.chat.completions.calls[0]
    assert call["model"] == "deepseek-chat"
    assert call["response_format"]["type"] == "json_schema"
    assert call["response_format"]["json_schema"]["strict"] is True
    assert call["response_format"]["json_schema"]["name"] == "NewsItem"
    system = call["messages"][0]["content"]
    assert "提取资讯" in system and '"topics"' in system


async def test_strict_schema_satisfies_openai_requirements():
    """P2-4：strict 模式的 schema 必须满足 OpenAI 硬性要求——
    additionalProperties:false 且所有属性入 required，否则官方端点直接 400。"""
    p = _provider(resp=_FakeResp(NEWS_JSON))
    await p.extract("x", NewsItem)
    js = p.client.chat.completions.calls[0]["response_format"]["json_schema"]["schema"]
    assert js["additionalProperties"] is False
    assert sorted(js["required"]) == sorted(js["properties"].keys())


async def test_response_format_none_omits_param():
    p = _provider(resp=_FakeResp(NEWS_JSON), response_format="none")
    await p.extract("x", NewsItem)
    assert "response_format" not in p.client.chat.completions.calls[0]


async def test_response_format_json_object():
    p = _provider(resp=_FakeResp(NEWS_JSON), response_format="json_object")
    await p.extract("x", NewsItem)
    assert p.client.chat.completions.calls[0]["response_format"] == {"type": "json_object"}


async def test_invalid_response_format_rejected():
    with pytest.raises(ValueError, match="response_format"):
        OpenAICompatProvider(model="m", client=_FakeClient(), response_format="xml")


async def test_prose_wrapped_json_still_parses():
    p = _provider(resp=_FakeResp(f"好的，结果如下：\n{NEWS_JSON}"))
    result = await p.extract("x", NewsItem)
    assert result.item.title.startswith("Acme")


async def test_429_normalized_transient():
    p = _provider(error=_FakeStatusError("rate limited", 429))
    with pytest.raises(TransientProviderError):
        await p.extract("x", NewsItem)


async def test_5xx_normalized_transient():
    p = _provider(error=_FakeStatusError("server busy", 503))
    with pytest.raises(TransientProviderError):
        await p.extract("x", NewsItem)


async def test_auth_error_not_transient():
    p = _provider(error=_FakeStatusError("invalid api key", 401))
    with pytest.raises(Exception) as exc_info:
        await p.extract("x", NewsItem)
    assert not isinstance(exc_info.value, TransientProviderError)


async def test_empty_content_raises():
    p = _provider(resp=_FakeResp(""))
    with pytest.raises(RuntimeError, match="空响应"):
        await p.extract("x", NewsItem)


async def test_invalid_json_raises_with_snippet():
    p = _provider(resp=_FakeResp("不是 JSON"))
    with pytest.raises(ValueError, match="片段"):
        await p.extract("x", NewsItem)


def test_missing_key_rejected(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="DEEPSEEK_API_KEY"):
        OpenAICompatProvider(model="deepseek-chat",
                             base_url="https://api.deepseek.com/v1",
                             api_key_env="DEEPSEEK_API_KEY")


# ---------- 配置切换（验收：仅改 settings.yaml 的 primary 即可切换） ----------

def test_stack_switches_via_settings_only(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "k")
    cfg = {"primary": "openai-compat",
           "openai-compat": {"model": "deepseek-chat",
                             "base_url": "https://api.deepseek.com/v1",
                             "api_key_env": "DEEPSEEK_API_KEY", "rpm": 20}}
    stack = create_provider_stack(cfg)
    assert stack.name == "openai-compat"
    assert stack.inner.name == "openai-compat"  # 无可用 fallback → 单供应商 + 限速


# ---------- live 冒烟（需 DEEPSEEK/OPENAI Key，默认跳过） ----------

@pytest.mark.live
@pytest.mark.skipif(not (os.environ.get("DEEPSEEK_API_KEY")
                         or os.environ.get("OPENAI_API_KEY")),
                    reason="需要 DEEPSEEK_API_KEY 或 OPENAI_API_KEY")
async def test_openai_compat_live_smoke():
    if os.environ.get("DEEPSEEK_API_KEY"):
        p = OpenAICompatProvider(model="deepseek-chat",
                                 base_url="https://api.deepseek.com/v1",
                                 api_key_env="DEEPSEEK_API_KEY")
    else:
        p = OpenAICompatProvider(model="gpt-4o-mini")
    sample = ("Acme 公司今日宣布推出新一代数据平台 Horizon，并完成 2 亿美元 C 轮融资，"
              "本季度营收同比增长 45%。")
    result = await p.extract(sample, NewsItem, instruction="从以下正文提取行业资讯")
    assert isinstance(result.item, NewsItem) and result.item.title
    print(f"\n[live] {result.provider}/{result.model} "
          f"tokens: {result.input_tokens} in / {result.output_tokens} out")
