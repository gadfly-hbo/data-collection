"""业务 Schema 公共基类：来源追溯字段。"""
from datetime import datetime, timezone

from pydantic import BaseModel, Field


class BaseSchema(BaseModel):
    """所有业务 Schema 的公共字段。

    source_url / scraped_at 由 pipeline 在落库前用 TaskSpec 与当前时间覆盖，
    LLM 不负责生成，因此带默认值、在 Structured Output 中非必填。
    """

    source_url: str = Field(default="", description="采集来源页面的完整 URL")
    scraped_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        description="抓取时间（UTC，由系统写入）",
    )
