"""T5.4：对话式需求规划器测试。"""
from core.planner import plan_with_user
from core.providers.base import ExtractionResult
from models.plan_schema import CollectionPlan, PlanReply


class _FakeProvider:
    def __init__(self, item):
        self.item = item
        self.calls: list = []

    async def extract(self, content, schema, *, instruction=""):
        self.calls.append({"content": content, "instruction": instruction,
                           "schema": schema})
        return ExtractionResult(item=self.item, input_tokens=1, output_tokens=1,
                                provider="fake", model="m")


def _plan() -> CollectionPlan:
    return CollectionPlan(name="HN 热点", url="https://news.ycombinator.com",
                          schema_type="NewsItem", interval_s=3600,
                          instruction="关注 AI", use_browser=False)


async def test_plan_complete_when_info_sufficient():
    provider = _FakeProvider(PlanReply(reply="已整理为计划，请确认", plan=_plan()))
    reply = await plan_with_user(
        provider, [{"role": "user", "content": "帮我每小时看一下 HN 热点"}],
        ["NewsItem", "CompetitorEvent"])

    assert reply.plan is not None
    assert reply.plan.url.endswith("ycombinator.com")
    assert reply.plan.interval_s == 3600

    call = provider.calls[0]
    assert call["schema"] is PlanReply
    assert "NewsItem" in call["instruction"] and "CompetitorEvent" in call["instruction"]
    assert "用户：帮我每小时看一下 HN 热点" in call["content"]


async def test_plan_null_when_info_incomplete():
    provider = _FakeProvider(PlanReply(reply="请把页面链接发我", plan=None))
    reply = await plan_with_user(
        provider, [{"role": "user", "content": "帮我盯一下科技新闻"}],
        ["NewsItem"])
    assert reply.plan is None
    assert "链接" in reply.reply


async def test_history_formats_roles_in_chinese():
    provider = _FakeProvider(PlanReply(reply="好的", plan=None))
    await plan_with_user(provider, [
        {"role": "user", "content": "想采集点东西"},
        {"role": "assistant", "content": "要采集哪个页面？"},
        {"role": "user", "content": "https://a.example"},
    ], ["NewsItem"])
    content = provider.calls[0]["content"]
    assert "用户：想采集点东西" in content
    assert "助手：要采集哪个页面？" in content
    assert "用户：https://a.example" in content
