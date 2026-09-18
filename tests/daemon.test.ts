import { describe, expect, it, vi } from "vitest";

import { BudgetExhausted, BudgetGuard } from "../src/budget.ts";
import { RunStatus } from "../src/status.ts";
import type { RunOutcome } from "../src/pipeline.ts";
import { NewsItem } from "../src/models/schemas.ts";
import { Database } from "../src/storage/db.ts";
import { enabledSources, runSource, runTick, type DaemonContext } from "../scripts/run-daemon.ts";
import { FakeProvider, fakeResult, validNewsItem } from "./helpers.ts";

function okOutcome(url = "https://a.example/1", over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    status: RunStatus.SUCCESS, url, inputTokens: 1, outputTokens: 1,
    provider: "fake", model: "m", durationMs: 1, ...over,
  };
}

function fakeCtx(pipeline: unknown, budget: BudgetGuard | null = null, clock?: () => number): DaemonContext {
  return {
    pipeline,
    fetcher: null,
    budget,
    busy: Promise.resolve(),
    lastRun: new Map(),
    tickS: 30,
    notifyEnabled: false,
    clock: clock ?? (() => Date.now()),
  } as never;
}

const src = (over: Record<string, unknown> = {}) => ({
  id: 7, url: "https://a.example/1", schema_type: "NewsItem", interval_s: 60,
  enabled: 1, use_browser: 0, instruction: "", ...over,
});

describe("daemon：单来源任务", () => {
  it("预算熔断跳过：不派发、lastRun 由 runTick 推进", async () => {
    const db = new Database(":memory:");
    const calls: unknown[] = [];
    const pipeline = { run: async (t: unknown) => { calls.push(t); return okOutcome(); } };
    const budget = new BudgetGuard(db, 0, 999999);
    const outcome = await runSource(src(), fakeCtx(pipeline, budget));
    expect(outcome).toBeNull();
    expect(calls.length).toBe(0);
    db.close();
  });

  it("source_id / use_browser 透传；成功返回 outcome", async () => {
    const seen: { sourceId?: number | null; useBrowser?: boolean }[] = [];
    const pipeline = { run: async (t: { sourceId?: number; useBrowser?: boolean }) => { seen.push(t); return okOutcome(); } };
    const outcome = await runSource(src({ use_browser: 1 }), fakeCtx(pipeline));
    expect(outcome?.status).toBe(RunStatus.SUCCESS);
    expect(seen[0].sourceId).toBe(7);
    expect(seen[0].useBrowser).toBe(true);
  });

  it("非法 schema_type 隔离：单来源报错不影响其余来源", async () => {
    const calls: string[] = [];
    const pipeline = { run: async (t: { url: string }) => { calls.push(t.url); return okOutcome(t.url); } };
    const ctx = fakeCtx(pipeline);
    const bad = await runSource(src({ url: "https://bad.example", schema_type: "Nope" }), ctx);
    expect(bad).toBeNull();
    const good = await runSource(src({ url: "https://good.example" }), ctx);
    expect(good?.status).toBe(RunStatus.SUCCESS);
    expect(calls).toEqual(["https://good.example"]); // 坏来源未进 pipeline
  });

  it("串行 Worker：并发来源不交叉执行", async () => {
    const events: string[] = [];
    const pipeline = {
      run: async (t: { url: string }) => {
        events.push(`start:${t.url}`);
        await new Promise((r) => setTimeout(r, 10));
        events.push(`end:${t.url}`);
        return okOutcome(t.url);
      },
    };
    const ctx = fakeCtx(pipeline);
    await Promise.all([
      runSource(src(), ctx),
      runSource(src({ url: "https://a.example/2" }), ctx),
    ]);
    expect(events).toEqual([
      "start:https://a.example/1", "end:https://a.example/1",
      "start:https://a.example/2", "end:https://a.example/2",
    ]);
  });
});

describe("daemon：tick 调度（sources 表驱动）", () => {
  it("只调度启用来源；间隔内不重复；改间隔下个 tick 生效", async () => {
    const db = new Database(":memory:");
    db.upsertSource({ url: "https://a.example/1", schemaType: "NewsItem", intervalS: 60 });
    db.upsertSource({ url: "https://b.example/2", schemaType: "NewsItem", intervalS: 60, enabled: false });
    const calls: string[] = [];
    const pipeline = { run: async (t: { url: string }) => { calls.push(t.url); return okOutcome(t.url); } };
    let now = 1_000_000;
    const ctx = fakeCtx(pipeline, null, () => now);

    await runTick(ctx, db);
    expect(calls).toEqual(["https://a.example/1"]); // 停用来源不调度

    await runTick(ctx, db); // 未到期
    now += 30_000;
    await runTick(ctx, db);
    expect(calls.length).toBe(1);

    now += 31_000;
    await runTick(ctx, db);
    expect(calls.length).toBe(2); // 超过 60s 间隔，再次执行

    // 面板把间隔改为 3600s → 下一个 tick 按新间隔现算
    db.upsertSource({ url: "https://a.example/1", schemaType: "NewsItem", intervalS: 3600 });
    now += 60_000;
    await runTick(ctx, db);
    expect(calls.length).toBe(2);
    db.close();
  });
});
