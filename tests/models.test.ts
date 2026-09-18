import { describe, expect, it } from "vitest";

import { CompetitorEvent, NewsItem, SCHEMA_REGISTRY, getSchema, toJsonSchema } from "../src/models/schemas.ts";

const ALL = [NewsItem, CompetitorEvent];

function hasCjk(text: string): boolean {
  return /[一-鿿]/.test(text);
}

describe("models：提取 Schema", () => {
  it.each(ALL)("zod 校验：最小 JSON 合法、基类默认值生效", (schema) => {
    const minimal =
      schema === NewsItem
        ? { title: "t", summary: "s", topics: ["AI"], sentiment: "neutral" }
        : { company: "A", event_type: "funding", headline: "h", detail: "d", impact_level: "high" };
    const item = schema.parse(minimal) as Record<string, unknown>;
    expect(item.source_url).toBe(""); // 基类默认值，pipeline 落库前覆盖
    expect(item.scraped_at).toBeTruthy();
  });

  it("NewsItem 拒绝非法 sentiment", () => {
    expect(() =>
      NewsItem.parse({ title: "t", summary: "s", topics: [], sentiment: "meh" }),
    ).toThrow();
  });

  it.each(ALL)("JSON Schema 可序列化且字段带中文 description", (schema) => {
    const js = toJsonSchema(schema) as {
      properties: Record<string, { description?: string }>;
    };
    expect(js.properties).toBeTruthy();
    for (const [name, prop] of Object.entries(js.properties)) {
      expect(hasCjk(prop.description ?? ""), `字段 ${name} 缺少中文 description`).toBe(true);
    }
  });

  it("registry：注册/反查/未知报错", () => {
    expect(getSchema("NewsItem")).toBe(NewsItem);
    expect(Object.keys(SCHEMA_REGISTRY)).toContain("CompetitorEvent");
    expect(() => getSchema("Nope")).toThrow(/未知 schema_type/);
  });
});
