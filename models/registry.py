"""schema_type 字符串 → Pydantic 模型类的注册表。

sources.yaml 中的 schema_type 与 crawl_runs / extracted_items 落库值均使用类名。
"""
from models.base_schema import BaseSchema
from models.competitor_schema import CompetitorEvent
from models.news_schema import NewsItem

SCHEMA_REGISTRY: dict[str, type[BaseSchema]] = {
    NewsItem.__name__: NewsItem,
    CompetitorEvent.__name__: CompetitorEvent,
}


def get_schema(name: str) -> type[BaseSchema]:
    try:
        return SCHEMA_REGISTRY[name]
    except KeyError:
        raise KeyError(
            f"未知 schema_type: {name!r}，可用值：{sorted(SCHEMA_REGISTRY)}"
        ) from None
