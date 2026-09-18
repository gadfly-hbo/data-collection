import { describe, expect, it } from "vitest";

import {
  discoverSources,
  extractFinalText,
  extractJsonArray,
  parseCandidates,
  type DiscoverySession,
} from "../src/discovery/agent.ts";
import { Database } from "../src/storage/db.ts";

const CANDIDATES_JSON = JSON.stringify([
  { name: "HackerNews", url: "https://news.ycombinator.com", reason: "技术热点聚合", schema_type: "NewsItem" },
  { name: "已入库来源", url: "https://a.example/existing", reason: "重复", schema_type: "NewsItem" },
  { name: "坏URL", url: "not-a-url", reason: "非法", schema_type: "NewsItem" },
]);

function fakeSession(text: string, error?: string): () => Promise<DiscoverySession> {
  return async () => ({
    prompt: async () => {},
    messages: [{
      role: "assistant",
      stopReason: error ? "error" : "stop",
      errorMessage: error,
      content: [{ type: "text", text }],
    }],
  });
}

describe("discovery：来源发现 Agent", () => {
  it("parseCandidates：提取数组、zod 校验、非法 URL 丢弃", () => {
    const text = `说明文字\n${CANDIDATES_JSON}\n其他`;
    const candidates = parseCandidates(text);
    expect(candidates.length).toBe(2); // 坏 URL 被丢
    expect(candidates[0].name).toBe("HackerNews");
  });

  it("extractJsonArray：感知字符串内括号", () => {
    expect(extractJsonArray('前置 [{"a": "x]y"}] 后置')).toBe('[{"a": "x]y"}]');
    expect(extractJsonArray("没有数组")).toBe("没有数组");
  });

  it("extractFinalText：取最后一条 assistant 文本", () => {
    expect(extractFinalText([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "第一条" }] },
      { role: "assistant", content: [{ type: "text", text: "最终" }] },
    ])).toBe("最终");
    expect(extractFinalText([])).toBe("");
  });

  it("发现结果与现有来源去重", async () => {
    const db = new Database(":memory:");
    db.upsertSource({ url: "https://a.example/existing", schemaType: "NewsItem" });
    const out = await discoverSources("技术热点", db, {
      sessionFactory: fakeSession(`候选如下：\n${CANDIDATES_JSON}`),
    });
    expect(out.length).toBe(1); // 已入库来源被过滤
    expect(out[0].url).toBe("https://news.ycombinator.com");
    db.close();
  });

  it("供应商错误（配额耗尽）→ 抛可读错误", async () => {
    const db = new Database(":memory:");
    await expect(
      discoverSources("x", db, { sessionFactory: fakeSession("", "429 用量上限") }),
    ).rejects.toThrow(/供应商错误/);
    db.close();
  });

  it("空产出 → 抛错", async () => {
    const db = new Database(":memory:");
    await expect(
      discoverSources("x", db, { sessionFactory: fakeSession("") }),
    ).rejects.toThrow(/未产出/);
    db.close();
  });
});
