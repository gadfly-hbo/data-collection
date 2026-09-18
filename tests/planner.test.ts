import { describe, expect, it } from "vitest";

import { PlanReply } from "../src/models/plan.ts";
import { planWithUser } from "../src/planner.ts";
import { FakeProvider, fakeResult } from "./helpers.ts";

describe("planner 对话式需求收集", () => {
  it("信息齐全 → 计划草案；schema 名单注入系统提示", async () => {
    const reply = PlanReply.parse({
      reply: "已整理为计划，请确认",
      plan: {
        name: "HN 热点", url: "https://news.ycombinator.com", schema_type: "NewsItem",
        interval_s: 3600, instruction: "关注 AI", use_browser: false,
      },
    });
    const provider = new FakeProvider([fakeResult(reply)]);
    const out = await planWithUser(provider,
      [{ role: "user", content: "帮我每小时看一下 HN 热点" }],
      ["NewsItem", "CompetitorEvent"]);
    expect(out.plan?.url).toContain("ycombinator.com");
    expect(provider.calls[0].instruction).toContain("NewsItem");
    expect(provider.calls[0].instruction).toContain("CompetitorEvent");
    expect(provider.calls[0].content).toContain("用户：帮我每小时看一下 HN 热点");
  });

  it("信息不齐 → plan 为 null，只追问", async () => {
    const provider = new FakeProvider([fakeResult(PlanReply.parse({ reply: "请把页面链接发我", plan: null }))]);
    const out = await planWithUser(provider, [{ role: "user", content: "帮我盯一下科技新闻" }], ["NewsItem"]);
    expect(out.plan).toBeNull();
    expect(out.reply).toContain("链接");
  });

  it("对话按角色排版（用户/助手）", async () => {
    const provider = new FakeProvider([fakeResult(PlanReply.parse({ reply: "好的", plan: null }))]);
    await planWithUser(provider, [
      { role: "user", content: "想采集点东西" },
      { role: "assistant", content: "要采集哪个页面？" },
      { role: "user", content: "https://a.example" },
    ], ["NewsItem"]);
    const content = provider.calls[0].content;
    expect(content).toContain("用户：想采集点东西");
    expect(content).toContain("助手：要采集哪个页面？");
  });
});
