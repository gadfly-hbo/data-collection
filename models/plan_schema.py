"""对话式需求收集的结构化产出模型（不注册进 SCHEMA_REGISTRY——它是规划器输出，
不是采集源的提取 Schema）。"""
from pydantic import BaseModel, Field


class CollectionPlan(BaseModel):
    """助手与用户对话后整理出的采集计划草案，需用户确认后才执行。"""

    name: str = Field(description="来源名称，简短易读，如「HackerNews 技术热点」")
    url: str = Field(description="采集目标页面的完整 URL，http/https 开头")
    schema_type: str = Field(description="数据类型（对应 registry 注册的类名）")
    interval_s: int = Field(
        description="采集间隔秒数；运营语境换算：每小时 3600、每天 86400、每周 604800")
    instruction: str = Field(
        default="", description="附加提取关注点（自然语言），如「重点关注 AI 政策」")
    use_browser: bool = Field(
        default=False, description="目标站是首页/列表/SPA 等需要 JS 渲染时为 true")


class PlanReply(BaseModel):
    """规划器单轮回复：对话文字 + （信息齐全时的）计划草案。"""

    reply: str = Field(
        description="给用户的中文回复：信息不齐时只提一个最关键的问题；齐全时是一句确认说明")
    plan: CollectionPlan | None = Field(
        default=None, description="信息齐全时给出完整计划草案，否则为 null")
