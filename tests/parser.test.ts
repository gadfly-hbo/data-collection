import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractMarkdown } from "../src/parser.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

describe("parser 正文抽取", () => {
  it("正文型页面 → 非空 Markdown 且剥离导航/评论/页脚", () => {
    const md = extractMarkdown(read("article.html"), "https://example.test/a/1");
    expect(md).toBeTruthy();
    expect(md).toContain("量子纠错");
    expect(md).not.toContain("沙发");
    expect(md).not.toContain("首页");
    expect(md).not.toContain("保留所有权利");
  });

  it("链接列表页 / 空输入 → null", () => {
    expect(extractMarkdown(read("link_list.html"))).toBeNull();
    expect(extractMarkdown("")).toBeNull();
    expect(extractMarkdown("   \n  ")).toBeNull();
  });
});
