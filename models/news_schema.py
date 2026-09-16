"""行业资讯 / 舆情监测 Schema。"""
from datetime import datetime
from typing import Literal

from pydantic import Field

from models.base_schema import BaseSchema


class NewsItem(BaseSchema):
    """单条行业资讯的结构化描述。"""

    title: str = Field(description="资讯标题，精炼保留原意")
    summary: str = Field(description="内容摘要，2~4 句话概括核心信息")
    topics: list[str] = Field(description="主题标签列表，3~8 个，如 ['AI', '监管']")
    sentiment: Literal["positive", "neutral", "negative"] = Field(
        description="舆情倾向：positive / neutral / negative"
    )
    published_at: datetime | None = Field(
        default=None, description="发布时间，页面未标注则为 null"
    )
    author: str | None = Field(default=None, description="作者或来源媒体，未标注则为 null")
