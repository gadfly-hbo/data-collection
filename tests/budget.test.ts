import { describe, expect, it } from "vitest";

import { BudgetExhausted, BudgetGuard } from "../src/budget.ts";
import { Database } from "../src/storage/db.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

function guard(db: Database, maxTasks = 3, maxTokens = 1000): BudgetGuard {
  return new BudgetGuard(db, maxTasks, maxTokens, () => TODAY);
}

function billableRun(db: Database, url: string, inputTokens = 100, status = "SUCCESS"): void {
  db.insertRun({ url, status, provider: "fake", model: "m", inputTokens });
}

describe("budget 日预算熔断", () => {
  it("空台账在预算内", () => {
    const db = new Database(":memory:");
    expect(guard(db).check()).toEqual({ tasks: 0, tokens: 0 });
    db.close();
  });

  it("任务数上限触发并带可读消息", () => {
    const db = new Database(":memory:");
    const g = guard(db, 3);
    for (let i = 0; i < 3; i++) billableRun(db, `https://a.example/${i}`);
    expect(() => g.check()).toThrow(BudgetExhausted);
    expect(() => g.check()).toThrow(/任务数.*3\/3/);
    db.close();
  });

  it("token 上限触发", () => {
    const db = new Database(":memory:");
    billableRun(db, "https://a.example/1", 500);
    expect(() => guard(db, 10, 500).check()).toThrow(/input tokens.*500\/500/);
    db.close();
  });

  it("SKIPPED/BLOCKED 不占预算；SCHEMA_ERROR 计费；昨日不占今日", () => {
    const db = new Database(":memory:");
    for (let i = 0; i < 5; i++) db.insertRun({ url: `https://a.example/${i}`, status: "SKIPPED_UNCHANGED" });
    db.insertRun({ url: "https://a.example/b", status: "BLOCKED" });
    billableRun(db, "https://a.example/se", 0, "SCHEMA_ERROR");
    const g = guard(db, 2);
    expect(g.usage()).toEqual({ tasks: 1, tokens: 0 });

    // 昨日数据不占今日预算
    const yesterdayId = db.insertRun({ url: "https://a.example/old", status: "SUCCESS", provider: "f", model: "m" });
    db.conn.prepare("UPDATE crawl_runs SET created_at = ? WHERE id = ?").run(`${YESTERDAY} 10:00:00`, yesterdayId);
    expect(g.usage().tasks).toBe(1);
    db.close();
  });
});
