import { describe, expect, it } from "vitest";

import { PlanReply } from "../src/models/plan.ts";
import { planWithUser } from "../src/planner.ts";
import { FakeProvider, fakeResult } from "./helpers.ts";

describe("切片4：chat 研究意图衔接", () => {
  it("intent=research 透传（plan 为空时仍可携带引导）", async () => {
    const provider = new FakeProvider([fakeResult(PlanReply.parse({
      reply: "这需要多步检索与写作，建议在工作台创建「企业研究：瑞幸咖啡」",
      plan: null, intent: "research",
      research: { template: "company-research", topic: "瑞幸咖啡扩张策略" },
    }))]);
    const out = await planWithUser(provider,
      [{ role: "user", content: "帮我深入研究瑞幸咖啡最近半年的扩张策略" }], ["NewsItem"]);
    expect(out.intent).toBe("research");
    expect(out.research?.template).toBe("company-research");
  });

  it("缺省 intent 兼容旧行为（undefined 归一为 collect）", async () => {
    const provider = new FakeProvider([fakeResult(PlanReply.parse({ reply: "请给链接", plan: null }))]);
    const out = await planWithUser(provider, [{ role: "user", content: "采集点东西" }], ["NewsItem"]);
    expect(out.intent).toBe("collect");
  });
});
