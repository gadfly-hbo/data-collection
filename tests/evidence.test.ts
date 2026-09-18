import { describe, expect, it } from "vitest";

import { parseEvidence } from "../src/research/evidence.ts";

const SAMPLE = `已使用 web_search 实际检索。

[A1.1] 【深圳市规自局/2026-03】【等级 A】 前海合作区扩区至 120km²。来源：https://pnr.sz.gov.cn/x
[A1.2] 【深圳统计/2026-05】【等级 B】 片区常住增速 8%。来源：http://tjj.sz.gov.cn/y
[B2.1] 【赢商网/2026-06】【等级 C】 万象前海日均客流 4.2 万，需交叉验证。来源：https://m.winshang.com/z
推断：租金上行（置信度：中）

数据缺口：竞品出租率无公开来源`;

describe("切片3：证据解析", () => {
  it("行级解析编号/等级/来源 URL，非证据行忽略", () => {
    const rows = parseEvidence(SAMPLE);
    expect(rows.length).toBe(3);
    expect(rows[0]).toMatchObject({ id: "A1.1", grade: "A", url: "https://pnr.sz.gov.cn/x" });
    expect(rows[2].grade).toBe("C");
    expect(rows[1].text).toContain("常住增速");
  });

  it("无证据 → 空数组（前端降级纯 Markdown）", () => {
    expect(parseEvidence("没有结构化证据")).toEqual([]);
  });
});
