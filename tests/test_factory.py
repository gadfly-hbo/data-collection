"""T1.5 补充：Provider 工厂测试。"""
import pytest

from core.providers.factory import create_provider


def test_factory_creates_anthropic_compat(monkeypatch):
    monkeypatch.setenv("MINIMAX_API_KEY", "test-key")
    p = create_provider("anthropic-compat", {
        "model": "MiniMax-M3",
        "base_url": "https://api.minimax.cn/anthropic",
        "api_key_env": "MINIMAX_API_KEY",
        "max_tokens": 1024,
    })
    assert p.name == "anthropic-compat"
    assert p.model == "MiniMax-M3"
    assert p.max_tokens == 1024


def test_factory_gemini_key_gate(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        create_provider("gemini", {})
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    assert create_provider("gemini", {}).name == "gemini"


def test_factory_unknown_provider():
    with pytest.raises(ValueError, match="未知 provider"):
        create_provider("does-not-exist", {})
