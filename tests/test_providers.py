"""T1.5：LLMProvider 协议与 Provider 实现验收测试（mock，不打真实 API）。"""
import json
import os
import pathlib

import pytest
import yaml
from pydantic import ValidationError

from core.providers.base import ExtractionResult, TransientProviderError
from core.providers.factory import create_provider
from core.providers.gemini import GeminiProvider
from models.news_schema import NewsItem

ROOT = pathlib.Path(__file__).resolve().parents[1]


# ---------- 测试替身：模拟 google-genai 客户端 ----------

class _FakeUsage:
    def __init__(self, prompt: int, candidates: int):
        self.prompt_token_count = prompt
        self.candidates_token_count = candidates


class _FakeResp:
    def __init__(self, text: str | None, usage: _FakeUsage | None = None):
        self.text = text
        self.usage_metadata = usage if usage is not None else _FakeUsage(100, 20)


class _FakeModels:
    def __init__(self, resp: _FakeResp | None = None, error: Exception | None = None):
        self.resp = resp
        self.error = error
        self.calls: list[dict] = []

    async def generate_content(self, *, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        if self.error is not None:
            raise self.error
        return self.resp


class _FakeAio:
    def __init__(self, models: _FakeModels):
        self.models = models


class _FakeClient:
    def __init__(self, resp: _FakeResp | None = None, error: Exception | None = None):
        self.aio = _FakeAio(_FakeModels(resp, error))


def _news_json(**overrides) -> str:
    data = {
        "title": "Acme 发布新一代数据平台",
        "summary": "Acme 宣布推出 Horizon 平台并完成 C 轮融资。",
        "topics": ["数据平台", "融资"],
        "sentiment": "positive",
    }
    data.update(overrides)
    return json.dumps(data, ensure_ascii=False)


def _provider(resp=None, error=None) -> GeminiProvider:
    return GeminiProvider(client=_FakeClient(resp, error))


# ---------- 验收：schema 约束传入、token 用量提取、429 归一化 ----------

async def test_extract_passes_schema_and_parses():
    p = _provider(resp=_FakeResp(_news_json()))
    result = await p.extract("正文内容……", NewsItem, instruction="提取行业资讯")

    assert isinstance(result, ExtractionResult)
    assert isinstance(result.item, NewsItem)
    assert result.item.title.startswith("Acme")
    assert (result.input_tokens, result.output_tokens) == (100, 20)
    assert result.provider == "gemini"

    call = p.client.aio.models.calls[0]
    assert call["config"].response_mime_type == "application/json"
    assert call["config"].response_schema is NewsItem  # Schema 约束被传入
    assert "正文内容……" in call["contents"]
    assert "提取行业资讯" in call["contents"]


async def test_429_normalized_to_transient():
    p = _provider(error=RuntimeError("429 RESOURCE_EXHAUSTED: quota exceeded"))
    with pytest.raises(TransientProviderError):
        await p.extract("x", NewsItem)


async def test_5xx_by_code_normalized_to_transient():
    class ServerBusy(Exception):
        code = 503

    p = _provider(error=ServerBusy("backend busy"))
    with pytest.raises(TransientProviderError):
        await p.extract("x", NewsItem)


async def test_auth_error_not_transient():
    p = _provider(error=RuntimeError("API key not valid. Please pass a valid API key."))
    with pytest.raises(RuntimeError) as exc_info:
        await p.extract("x", NewsItem)
    assert not isinstance(exc_info.value, TransientProviderError)


async def test_invalid_json_raises_validation_error():
    p = _provider(resp=_FakeResp(json.dumps({"title": "只有标题"})))
    with pytest.raises(ValidationError):
        await p.extract("x", NewsItem)


async def test_empty_response_raises():
    p = _provider(resp=_FakeResp(""))
    with pytest.raises(RuntimeError, match="空响应"):
        await p.extract("x", NewsItem)


def test_missing_api_key_rejected(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        GeminiProvider()


# ---------- live 冒烟：按 settings.yaml 与可用 Key 自动选供应商（默认跳过） ----------

def _pick_live_provider():
    from core.providers.factory import resolve_provider

    provider_cfg = yaml.safe_load(
        (ROOT / "config" / "settings.yaml").read_text())["provider"]
    try:
        return resolve_provider(provider_cfg)
    except RuntimeError as e:
        pytest.skip(str(e))


@pytest.mark.live
async def test_live_smoke_any_provider():
    provider = _pick_live_provider()
    sample = (
        "2026 年 9 月 15 日，Acme 公司宣布正式推出新一代数据平台 Horizon，"
        "并同步完成 2 亿美元 C 轮融资。公司称本季度营收同比增长 45%，"
        "新平台将首先面向制造业客户开放。"
    )
    result = await provider.extract(sample, NewsItem, instruction="从以下正文提取行业资讯")
    assert isinstance(result.item, NewsItem)
    assert result.item.title
    assert result.item.sentiment in ("positive", "neutral", "negative")
    assert result.input_tokens > 0
    print(f"\n[live] provider={result.provider} model={result.model} "
          f"tokens: {result.input_tokens} in / {result.output_tokens} out")
