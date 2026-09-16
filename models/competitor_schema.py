"""竞品动态 / 研报摘要 Schema。"""
from datetime import datetime
from typing import Literal

from pydantic import Field

from models.base_schema import BaseSchema


class CompetitorEvent(BaseSchema):
    """单条竞品动态的结构化描述。"""

    company: str = Field(description="公司或产品名称")
    event_type: Literal[
        "product_launch",
        "funding",
        "partnership",
        "leadership_change",
        "financial_report",
        "other",
    ] = Field(description="动态类型：产品发布 / 融资 / 合作 / 人事变动 / 财报 / 其他")
    headline: str = Field(description="一句话概括该动态")
    detail: str = Field(description="动态详情，保留关键数字与事实")
    impact_level: Literal["high", "medium", "low"] = Field(
        description="对我方业务的影响程度：high / medium / low"
    )
    event_date: datetime | None = Field(
        default=None, description="事件发生日期，页面未标注则为 null"
    )
