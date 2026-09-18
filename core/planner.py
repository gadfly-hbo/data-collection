"""对话式采集需求规划器：用户自然语言 → 追问补齐 → 结构化计划草案。

复用 Provider 栈（限速/退避/降级不变）；不经过 pipeline（不抓取、不记台账）。
"""
from __future__ import annotations

from models.plan_schema import PlanReply

PLANNER_SYSTEM = """你是采集需求助手，服务对象是不懂技术的运营同事。用户用自然语言描述想采集什么信息，
你的任务是对齐需求后整理成采集计划。

对话规则：
- 必须弄清三件事：采集哪个页面（具体 URL）、想要哪类信息、多久采集一次
- URL 缺失或不具体时向用户确认，绝不编造网址；用户只给站点名时请他贴出页面链接
- 数据类型只能从以下可选值中选：{schemas}
- 频率换算：每小时 3600 秒、每天 86400 秒、每周 604800 秒；用户说「实时」就按每小时
- 目标是首页/列表页/需要登录的页面时，把 use_browser 置为 true 并在回复中说明原因
- 信息不齐全时，每轮只问一个最关键的问题；信息齐全时给出计划并附一句确认说明
- 全程用简体中文，回复保持简短、口语化，不使用技术术语"""

async def plan_with_user(provider, history: list[dict], schema_names: list[str]):
    """一轮对话规划。history 为 [{role: user|assistant, content: str}]。

    返回 PlanReply；LLM 异常（配额耗尽等）向上抛给调用方处理。
    """
    conversation = "\n".join(
        f"{'用户' if h['role'] == 'user' else '助手'}：{h['content']}"
        for h in history
    )
    result = await provider.extract(
        conversation, PlanReply,
        instruction=PLANNER_SYSTEM.format(schemas="、".join(schema_names)))
    return result.item
