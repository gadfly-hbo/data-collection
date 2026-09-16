"""T1.5 补充：AnthropicCompatProvider 验收测试（mock 客户端，不打真实 API）。"""
import json

import pytest

from core.providers.anthropic_compat import AnthropicCompatProvider
from core.providers.base import TransientProviderError
from models.news_schema import NewsItem

NEWS_JSON = json.dumps({
    "title": "Acme 发布新一代数据平台",
    "summary": "Acme 宣布推出 Horizon 平台并完成 C 轮融资。",
    "topics": ["数据平台", "融资"],
    "sentiment": "positive",
}, ensure_ascii=False)


class _Block:
    def __init__(self, type_: str, text: str = ""):
        self.type = type_
        self.text = text


class _FakeUsage:
    def __init__(self, input_tokens: int, output_tokens: int):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _FakeResp:
    def __init__(self, blocks, usage=None, stop_reason="end_turn"):
        self.content = blocks
        self.usage = usage if usage is not None else _FakeUsage(120, 45)
        self.stop_reason = stop_reason


class _FakeMessages:
    def __init__(self, resp=None, error=None):
        self.resp = resp
        self.error = error
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.resp


class _FakeAnthropic:
    def __init__(self, resp=None, error=None):
        self.messages = _FakeMessages(resp, error)


class _FakeStatusError(Exception):
    """模拟 SDK 的状态错误（normalize_provider_error 读取 status_code 属性）。"""

    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.status_code = status_code


def _provider(resp=None, error=None, **kwargs) -> AnthropicCompatProvider:
    return AnthropicCompatProvider(model="MiniMax-M3",
                                   client=_FakeAnthropic(resp, error), **kwargs)


async def test_extract_injects_schema_and_parses():
    p = _provider(resp=_FakeResp([_Block("text", NEWS_JSON)]))
    result = await p.extract("正文内容……", NewsItem, instruction="提取行业资讯")

    assert result.item.title.startswith("Acme")
    assert (result.input_tokens, result.output_tokens) == (120, 45)
    assert result.provider == "anthropic-compat"
    assert result.model == "MiniMax-M3"

    call = p.client.messages.calls[0]
    assert call["model"] == "MiniMax-M3"
    assert "提取行业资讯" in call["system"]
    assert '"topics"' in call["system"]          # JSON Schema 注入 system prompt
    assert call["messages"] == [{"role": "user", "content": "正文内容……"}]


async def test_strips_markdown_code_fence():
    fenced = f"```json\n{NEWS_JSON}\n```"
    p = _provider(resp=_FakeResp([_Block("text", fenced)]))
    result = await p.extract("x", NewsItem)
    assert result.item.title.startswith("Acme")


async def test_extracts_json_from_surrounding_prose():
    noisy = f"好的，以下是提取结果：\n{NEWS_JSON}\n希望对你有帮助。"
    p = _provider(resp=_FakeResp([_Block("text", noisy)]))
    result = await p.extract("x", NewsItem)
    assert result.item.title.startswith("Acme")


async def test_thinking_blocks_are_ignored():
    blocks = [_Block("thinking", "先分析一下……"), _Block("text", NEWS_JSON)]
    p = _provider(resp=_FakeResp(blocks))
    result = await p.extract("x", NewsItem)
    assert result.item.summary


@pytest.mark.parametrize("status", [429, 500, 503])
async def test_transient_status_normalized(status):
    p = _provider(error=_FakeStatusError(f"HTTP {status}", status))
    with pytest.raises(TransientProviderError):
        await p.extract("x", NewsItem)


async def test_auth_error_not_transient():
    p = _provider(error=_FakeStatusError("invalid api key", 401))
    with pytest.raises(Exception) as exc_info:
        await p.extract("x", NewsItem)
    assert not isinstance(exc_info.value, TransientProviderError)


async def test_invalid_json_raises_with_snippet():
    p = _provider(resp=_FakeResp([_Block("text", "这不是 JSON")]))
    with pytest.raises(ValueError, match="片段"):
        await p.extract("x", NewsItem)


async def test_empty_text_raises():
    p = _provider(resp=_FakeResp([_Block("thinking", "只有思考")]))
    with pytest.raises(RuntimeError, match="空响应"):
        await p.extract("x", NewsItem)


def test_missing_key_rejected(monkeypatch):
    monkeypatch.delenv("MINIMAX_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="MINIMAX_API_KEY"):
        AnthropicCompatProvider(model="MiniMax-M3",
                                base_url="https://api.minimax.cn/anthropic",
                                api_key_env="MINIMAX_API_KEY")
