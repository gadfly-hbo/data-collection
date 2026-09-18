import { describe, expect, it } from "vitest";

import { listTemplates, RESEARCH_TEMPLATES } from "../src/research/templates/index.ts";
import { validateTemplate } from "../src/research/engine.ts";
import { makeAgentRunner, type AgentSessionLike } from "../src/research/agentRunner.ts";

describe("research/templates：注册表", () => {
  it("三模板合法注册且采证/写作/补证要求真实检索", () => {
    expect(Object.keys(RESEARCH_TEMPLATES).sort()).toEqual(["brand-research", "company-research", "district-research"]);
    for (const t of Object.values(RESEARCH_TEMPLATES)) {
      validateTemplate(t);
      const research = t.nodes.find((n) => n.id === "research");
      expect(research?.requireSearch).toBe(true);
      const fix = t.nodes.find((n) => n.id === "fix");
      expect(fix?.gate?.contains).toBe("NEED_FIX");
    }
    expect(listTemplates().length).toBe(3);
  });

  it("商圈模板保留 flow-center 语义（证据等级与缺口）", () => {
    const research = RESEARCH_TEMPLATES["district-research"].nodes.find((n) => n.id === "research")!;
    expect(research.prompt).toContain("分支 A");
    expect(research.prompt).toContain("分支 B");
    expect(research.prompt).toContain("数据缺口");
    expect(research.prompt).toContain("web_search");
  });
});

describe("research/agentRunner：pi SDK 节点执行器", () => {
  const fakeSession = (opts: { text?: string; error?: string; tools?: string[] } = {}): { factory: () => Promise<AgentSessionLike>; subscribed: ((e: { type: string; toolCall?: { name: string } }) => void)[] } => {
    const subscribed: ((e: { type: string; toolCall?: { name: string } }) => void)[] = [];
    const session: AgentSessionLike = {
      messages: [{
        role: "assistant",
        stopReason: opts.error ? "error" : "stop",
        errorMessage: opts.error,
        usage: { input: 1200, output: 300 },
        content: [{ type: "text", text: opts.text ?? "检索结论…" }],
      }],
      async prompt() {
        for (const fn of subscribed) {
          for (const t of opts.tools ?? ["minimax_web_search"]) fn({ type: "toolcall_start", toolCall: { name: t } });
        }
      },
      subscribe(fn) { subscribed.push(fn); },
    };
    return { factory: async () => session, subscribed };
  };

  it("收集文本/工具调用/用量", async () => {
    const { factory } = fakeSession();
    const r = await makeAgentRunner({ sessionFactory: factory })("任务");
    expect(r.text).toContain("检索结论");
    expect(r.usedTools).toEqual(["minimax_web_search"]);
    expect(r.inputTokens).toBe(1200);
  });

  it("事件缺失时从消息 toolCall 块收集工具证据", async () => {
    const session: AgentSessionLike = {
      messages: [{ role: "assistant", stopReason: "stop", usage: { input: 1, output: 1 },
        content: [{ type: "toolCall", name: "minimax_web_search" },
                  { type: "text", text: "检索结果汇总" }] }],
      async prompt() {}, subscribe() {},
    };
    const r = await makeAgentRunner({ sessionFactory: async () => session })("任务");
    expect(r.usedTools).toContain("minimax_web_search");
  });

  it("stopReason=error → 抛出（引擎转暂停续跑）", async () => {
    const { factory } = fakeSession({ error: "429 配额" });
    await expect(makeAgentRunner({ sessionFactory: factory })("任务")).rejects.toThrow(/429/);
  });

  it("无文本产出 → 抛出", async () => {
    const { factory } = fakeSession({ text: "" });
    await expect(makeAgentRunner({ sessionFactory: factory })("任务")).rejects.toThrow(/无文本产出/);
  });
});
