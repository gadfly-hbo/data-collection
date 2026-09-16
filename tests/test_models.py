"""T1.2：数据模型层验收测试。"""
import json

import pytest
from pydantic import ValidationError

from models.base_schema import BaseSchema
from models.competitor_schema import CompetitorEvent
from models.news_schema import NewsItem
from models.registry import get_schema

ALL_MODELS = [BaseSchema, NewsItem, CompetitorEvent]


def _has_cjk(text: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in text)


@pytest.mark.parametrize("model", ALL_MODELS)
def test_json_schema_serializable(model):
    schema = model.model_json_schema()
    assert schema["type"] == "object"
    assert schema["properties"]
    assert json.dumps(schema, ensure_ascii=False)


@pytest.mark.parametrize("model", ALL_MODELS)
def test_fields_have_chinese_descriptions(model):
    for name, prop in model.model_json_schema()["properties"].items():
        assert _has_cjk(prop.get("description", "")), (
            f"{model.__name__}.{name} 缺少中文 description（Structured Output 语义提示）"
        )


def test_news_item_minimal_json_validates():
    item = NewsItem.model_validate_json(json.dumps({
        "title": "测试标题",
        "summary": "测试摘要",
        "topics": ["AI"],
        "sentiment": "neutral",
    }, ensure_ascii=False))
    assert item.source_url == ""  # 基类默认值生效，pipeline 落库前覆盖
    assert item.scraped_at.tzinfo is not None
    assert item.published_at is None


def test_news_item_rejects_bad_sentiment():
    with pytest.raises(ValidationError):
        NewsItem.model_validate_json(json.dumps({
            "title": "t", "summary": "s", "topics": [], "sentiment": "meh",
        }))


def test_competitor_event_minimal_json_validates():
    item = CompetitorEvent.model_validate_json(json.dumps({
        "company": "Acme",
        "event_type": "funding",
        "headline": "完成 C 轮融资",
        "detail": "金额 2 亿美元",
        "impact_level": "high",
    }, ensure_ascii=False))
    assert item.impact_level == "high"


def test_registry_lookup():
    assert get_schema("NewsItem") is NewsItem
    assert get_schema("CompetitorEvent") is CompetitorEvent
    with pytest.raises(KeyError):
        get_schema("Nope")
