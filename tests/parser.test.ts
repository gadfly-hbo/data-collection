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

describe("parser 链接密度防线（对齐 trafilatura favor_precision 语义）", () => {
  it("HN 形态的链接列表 markdown → null（不消耗 LLM）", () => {
    const hnLike = `<html><body><article><table>${Array.from({ length: 30 }, (_, i) =>
      `<tr><td>${i + 1}.</td><td><a href="https://example.com/item${i}">Story Title Number ${i} Discussion</a></td>` +
      `<td><a href="https://example.com/user${i}">user${i}</a></td></tr>`).join("")}</table></article></body></html>`;
    expect(extractMarkdown(hnLike, "https://news.example")).toBeNull();
  });
});

describe("parser 真实 HN 形态回归", () => {
  it("hn_homepage fixture → null（链接密度防线）", () => {
    const { readFileSync } = require("node:fs");
    const html = readFileSync(join(FIXTURES, "hn_homepage.html"), "utf8");
    expect(extractMarkdown(html, "https://news.ycombinator.com")).toBeNull();
  });
});
