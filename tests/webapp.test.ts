import type { Server } from "node:http";
import { describe, expect, it } from "vitest";

import { PlanReply } from "../src/models/plan.ts";
import { RunStatus } from "../src/status.ts";
import type { RunOutcome } from "../src/pipeline.ts";
import { TransientProviderError } from "../src/providers/base.ts";
import { Database } from "../src/storage/db.ts";
import { createApp } from "../scripts/webapp.ts";
import type { DaemonContext } from "../scripts/run-daemon.ts";
import { FakeProvider, fakeResult, validNewsItem } from "./helpers.ts";

async function withApp(db: Database, pipeline: unknown, fn: (base: string) => Promise<void>, discover?: (t: string) => Promise<unknown>): Promise<void> {
  const ctx = {
    pipeline, fetcher: null, budget: null, busy: Promise.resolve(),
    lastRun: new Map(), tickS: 30, notifyEnabled: false, clock: () => Date.now(),
  } as never as DaemonContext;
  const app = createApp(ctx, db, { withScheduler: false, discover });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function seededDb(): Database {
  const db = new Database(":memory:");
  const sid = db.upsertSource({ url: "https://a.example/1", schemaType: "NewsItem", name: "A" });
  const runId = db.insertRun({ url: "https://a.example/1", status: "SUCCESS", sourceId: sid, provider: "fake", inputTokens: 10 });
  db.insertItem({
    runId, sourceUrl: "https://a.example/1", schemaType: "NewsItem",
    content: '{"title":"测试条目","summary":"s","topics":["t"],"sentiment":"neutral"}',
    dedupHash: "ab".repeat(32),
  });
  return db;
}

describe("webapp：Web 控制台 API", () => {
  it("首页与静态资源可访问", async () => {
    const db = seededDb();
    await withApp(db, { run: async () => okOutcome() }, async (base) => {
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain("棱镜采集工作台");
      expect(html).toContain("对话助手");
      const js = await fetch(`${base}/app.js`);
      expect(js.status).toBe(200);
    });
    db.close();
  });

  it("schemas/summary/sources/runs/items/export 端点", async () => {
    const db = seededDb();
    await withApp(db, { run: async () => okOutcome() }, async (base) => {
      const schemas = await (await fetch(`${base}/api/schemas`)).json();
      expect(Object.keys(schemas).sort()).toEqual(["CompetitorEvent", "NewsItem"]);
      expect(schemas.NewsItem.fields.title).toBeTruthy();

      const summary = await (await fetch(`${base}/api/summary`)).json();
      expect(summary.summary.total).toBe(1);
      expect(summary.summary.today_input_tokens).toBe(10);

      const sources = await (await fetch(`${base}/api/sources`)).json();
      expect(sources[0].last_status).toBe("SUCCESS");

      const runs = await (await fetch(`${base}/api/runs`)).json();
      expect(runs[0].status).toBe("SUCCESS");

      const items = await (await fetch(`${base}/api/items`)).json();
      expect(items.total).toBe(1);
      expect(items.items[0].item.title).toBe("测试条目");

      const csv = await fetch(`${base}/api/export?format=csv`);
      expect(csv.status).toBe(200);
      expect(csv.headers.get("content-disposition")).toContain("attachment");
      expect((await fetch(`${base}/api/export?format=xml`)).status).toBe(400);
    });
    db.close();
  });

  it("来源 CRUD：合法新增、非法拒绝、同 URL 更新、删除保护", async () => {
    const db = seededDb();
    await withApp(db, { run: async () => okOutcome() }, async (base) => {
      const post = (body: unknown) => fetch(`${base}/api/sources`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      expect((await post({ url: "https://new.example", schema_type: "NewsItem", interval_s: 60 })).status).toBe(200);
      expect((await post({ url: "bad", schema_type: "NewsItem" })).status).toBe(400);
      expect((await post({ url: "https://x.example", schema_type: "Nope" })).status).toBe(400);
      expect((await post({ url: "https://new.example", schema_type: "NewsItem" })).status).toBe(200);
      const sources = await (await fetch(`${base}/api/sources`)).json();
      expect(sources.length).toBe(2);

      // 有台账的来源删除 → 409；不存在 → 404
      const withRuns = sources.find((s: { name: string }) => s.name === "A");
      const del = await fetch(`${base}/api/sources/${withRuns.id}`, { method: "DELETE" });
      expect(del.status).toBe(409);
      expect((await fetch(`${base}/api/sources/999`, { method: "DELETE" })).status).toBe(404);
    });
    db.close();
  });

  it("立即采集：source_id 与 ad-hoc URL；非法 schema 拒绝", async () => {
    const db = seededDb();
    const seen: { url: string; sourceId?: number | null }[] = [];
    const pipeline = {
      run: async (t: { url: string; sourceId?: number | null }) => {
        seen.push(t);
        return okOutcome(t.url);
      },
    };
    await withApp(db, pipeline, async (base) => {
      const byId = await fetch(`${base}/api/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: 1 }),
      });
      expect((await byId.json()).ok).toBe(true);
      expect(seen[0].sourceId).toBe(1);

      const adhoc = await fetch(`${base}/api/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://ad.example/x" }),
      });
      expect((await adhoc.json()).ok).toBe(true);
      expect(seen[1].sourceId).toBeNull();

      const bad = await fetch(`${base}/api/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://x.example", schema_type: "Nope" }),
      });
      expect(bad.status).toBe(400);
    });
    db.close();
  });

  it("对话助手：计划回复 / 追问 / schema 兜底 / 供应商 503", async () => {
    const db = seededDb();
    const replyWithPlan = PlanReply.parse({
      reply: "计划已整理好",
      plan: { name: "HN", url: "https://news.ycombinator.com", schema_type: "Nope", interval_s: 3600 },
    });
    const pipeline = {
      run: async () => okOutcome(),
      provider: new FakeProvider([fakeResult(replyWithPlan)]),
    };
    await withApp(db, pipeline, async (base) => {
      const resp = await fetch(`${base}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: [{ role: "user", content: "帮我每小时盯 HN" }] }),
      });
      const body = await resp.json();
      expect(body.plan.url).toContain("ycombinator.com");
      expect(body.plan.schema_type).toBe("CompetitorEvent"); // Nope 兜底到注册表首项（字典序）

      expect((await fetch(`${base}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: [] }),
      })).status).toBe(422);
    });
    db.close();

    // 供应商不可用 → 503
    const db2 = new Database(":memory:");
    const failing = { run: async () => okOutcome(), provider: new FakeProvider([new TransientProviderError("429 上限")]) };
    await withApp(db2, failing, async (base) => {
      const resp = await fetch(`${base}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: [{ role: "user", content: "采集点新闻" }] }),
      });
      expect(resp.status).toBe(503);
      expect((await resp.json()).detail).toContain("稍后重试");
    });
    db2.close();
  });

  it("来源发现：/api/discover 返回候选；未启用返回 501", async () => {
    const db = seededDb();
    const discover = async () => [{ name: "HN", url: "https://news.ycombinator.com", reason: "r", schema_type: "NewsItem" }];
    await withApp(db, { run: async () => okOutcome() }, async (base) => {
      const resp = await fetch(`${base}/api/discover`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: "技术热点" }),
      });
      const body = await resp.json();
      expect(body.ok).toBe(true);
      expect(body.candidates[0].url).toContain("ycombinator");

      expect((await fetch(`${base}/api/discover`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      })).status).toBe(422);
    }, discover);
    db.close();

    const db2 = new Database(":memory:");
    await withApp(db2, { run: async () => okOutcome() }, async (base) => {
      const resp = await fetch(`${base}/api/discover`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: "x" }),
      });
      expect(resp.status).toBe(501);
    });
    db2.close();
  });
});

function okOutcome(url = "https://a.example/1"): RunOutcome {
  return {
    status: RunStatus.SUCCESS, url, inputTokens: 1, outputTokens: 1,
    provider: "fake", model: "m", durationMs: 1,
  };
}
