import type { Server } from "node:http";
import { describe, expect, it } from "vitest";

import { PlanReply } from "../src/models/plan.ts";
import { type RunOutcome } from "../src/pipeline.ts";
import { RunStatus } from "../src/status.ts";
import { TransientProviderError } from "../src/providers/base.ts";
import { Database } from "../src/storage/db.ts";
import { createApp } from "../scripts/webapp.ts";
import type { DaemonContext } from "../scripts/run-daemon.ts";
import { JobKernel } from "../src/jobs/kernel.ts";
import { FakeProvider, fakeResult } from "./helpers.ts";

function okOutcome(url = "https://a.example/1"): RunOutcome {
  return {
    status: RunStatus.SUCCESS, url, inputTokens: 1, outputTokens: 1,
    provider: "fake", model: "m", durationMs: 1,
  };
}

interface Deps {
  pipeline?: unknown;
  kernel?: JobKernel;
  discover?: (topic: string) => Promise<unknown>;
}

async function withApp(db: Database, deps: Deps, fn: (base: string) => Promise<void>): Promise<void> {
  const ctx = {
    kernel: deps.kernel ?? new JobKernel(db, {}),
    pipeline: deps.pipeline ?? { run: async () => okOutcome() },
    fetcher: null,
    db,
    notifyEnabled: false,
    tickS: 30,
  } as never as DaemonContext;
  const app = createApp(ctx, db, { withScheduler: false, discover: deps.discover });
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
    await withApp(db, {}, async (base) => {
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain("棱镜采集工作台");
      expect(html).toContain("对话助手");
      expect((await fetch(`${base}/app.js`)).status).toBe(200);
    });
    db.close();
  });

  it("schemas/summary/sources/runs/items/export 端点", async () => {
    const db = seededDb();
    await withApp(db, {}, async (base) => {
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
    await withApp(db, {}, async (base) => {
      const post = (body: unknown) => fetch(`${base}/api/sources`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      expect((await post({ url: "https://new.example", schema_type: "NewsItem", interval_s: 60 })).status).toBe(200);
      expect((await post({ url: "bad", schema_type: "NewsItem" })).status).toBe(400);
      expect((await post({ url: "https://x.example", schema_type: "Nope" })).status).toBe(400);
      expect((await post({ url: "https://new.example", schema_type: "NewsItem" })).status).toBe(200);
      const sources = await (await fetch(`${base}/api/sources`)).json();
      expect(sources.length).toBe(2);

      const withRuns = sources.find((s: { name: string }) => s.name === "A");
      const del = await fetch(`${base}/api/sources/${withRuns.id}`, { method: "DELETE" });
      expect(del.status).toBe(409);
      expect((await fetch(`${base}/api/sources/999`, { method: "DELETE" })).status).toBe(404);
    });
    db.close();
  });

  it("立即采集：source_id 走内核（detail 透传）；ad-hoc 走 pipeline；非法 schema 拒绝", async () => {
    const db = seededDb();
    const pipelineCalls: { url: string }[] = [];
    const pipeline = {
      run: async (t: { url: string }) => { pipelineCalls.push(t); return okOutcome(t.url); },
    };
    const kernel = new JobKernel(db, {
      source: {
        type: "source",
        async run() {
          return { status: "success" as const, inputTokens: 7, outputTokens: 3, detail: { ...okOutcome(), runId: 42 } };
        },
      },
    });
    await withApp(db, { pipeline, kernel }, async (base) => {
      const byId = await fetch(`${base}/api/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: 1 }),
      });
      const body = await byId.json();
      expect(body.ok).toBe(true);
      expect(body.run_id).toBe(42); // detail 透传 RunOutcome 契约

      const adhoc = await fetch(`${base}/api/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://ad.example/x" }),
      });
      expect((await adhoc.json()).ok).toBe(true);
      expect(pipelineCalls.map((c) => c.url)).toEqual(["https://ad.example/x"]); // ad-hoc 走 pipeline

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
    await withApp(db, { pipeline }, async (base) => {
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

    const db2 = new Database(":memory:");
    const failing = { run: async () => okOutcome(), provider: new FakeProvider([new TransientProviderError("429 上限")]) };
    await withApp(db2, { pipeline: failing }, async (base) => {
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
    await withApp(db, { discover }, async (base) => {
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
    });
    db.close();

    const db2 = new Database(":memory:");
    await withApp(db2, {}, async (base) => {
      const resp = await fetch(`${base}/api/discover`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: "x" }),
      });
      expect(resp.status).toBe(501);
    });
    db2.close();
  });
});

describe("webapp：connector 端点", () => {
  it("GET /api/connectors 列出注册表（参数含选项与约束）", async () => {
    const db = new Database(":memory:");
    await withApp(db, {}, async (base) => {
      const list = await (await fetch(`${base}/api/connectors`)).json();
      const weather = list.find((c: { id: string }) => c.id === "weather");
      expect(weather.name).toBe("天气数据");
      expect(weather.api).toBe(true);
      expect(weather.min_interval_s).toBe(3600);
      expect(weather.params.city.options).toContain("深圳");
    });
    db.close();
  });

  it("POST /api/jobs 创建 custom 任务；非法 connector/参数/间隔拒绝", async () => {
    const db = new Database(":memory:");
    await withApp(db, {}, async (base) => {
      const ok = await fetch(`${base}/api/jobs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connector: "weather", params: { city: "深圳" }, interval_s: 3600 }),
      });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.ok).toBe(true);
      expect(db.getSourceJob).toBeTruthy();
      const job = db.getJob(body.id) as { type: string; payload: string };
      expect(job.type).toBe("custom");
      expect(JSON.parse(job.payload).connector).toBe("weather");

      const badConn = await fetch(`${base}/api/jobs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connector: "nope" }) });
      expect(badConn.status).toBe(400);
      const badCity = await fetch(`${base}/api/jobs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connector: "weather", params: { city: "火星" } }) });
      expect(badCity.status).toBe(400);
      const badIv = await fetch(`${base}/api/jobs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connector: "weather", params: { city: "深圳" }, interval_s: 60 }) });
      expect(badIv.status).toBe(400);
    });
    db.close();
  });

  it("GET /api/dataset/:jobId 返回最新批次行；DELETE /api/jobs 停用", async () => {
    const db = new Database(":memory:");
    const jobId = db.insertJob({ type: "custom", name: "w", payload: '{"connector":"weather"}' });
    const runId = db.insertJobRun({ jobId, status: "success" });
    db.insertArtifact({ jobRunId: runId, kind: "dataset", title: "天气",
      content: '[{"ts":"T1","values":{"temperature_2m":28}}]', meta: '{"connector":"weather"}' });
    await withApp(db, {}, async (base) => {
      const data = await (await fetch(`${base}/api/dataset/${jobId}`)).json();
      expect(data.rows[0].values.temperature_2m).toBe(28);
      expect(data.meta.connector).toBe("weather");

      const del = await fetch(`${base}/api/jobs/${jobId}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      expect((db.getJob(jobId) as { enabled: number }).enabled).toBe(0);
    });
    db.close();
  });
});

describe("webapp：研究任务端点", () => {
  it("模板列表 / 创建待确认 / 确认激活 / 详情", async () => {
    const db = new Database(":memory:");
    await withApp(db, {}, async (base) => {
      const tpls = await (await fetch(`${base}/api/research/templates`)).json();
      expect(tpls.map((t: { id: string }) => t.id)).toContain("district-research");

      const created = await (await fetch(`${base}/api/research`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: "district-research", topic: "深圳前海商圈" }),
      })).json();
      expect(created.status).toBe("pending_confirmation");
      expect((db.getJob(created.id) as { enabled: number }).enabled).toBe(0); // 未确认不进调度

      expect((await fetch(`${base}/api/research`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: "ghost", topic: "x" })})).status).toBe(400);

      const confirmed = await fetch(`${base}/api/research/jobs/${created.id}/confirm`, { method: "POST" });
      expect((await confirmed.json()).ok).toBe(true);
      expect((db.getJob(created.id) as { enabled: number }).enabled).toBe(1);

      const detail = await (await fetch(`${base}/api/research/jobs/${created.id}`)).json();
      expect(detail.job.type).toBe("research");
      expect(detail.report).toBeNull();

      const jobs = await (await fetch(`${base}/api/research/jobs`)).json();
      expect(jobs.some((j: { id: number }) => j.id === created.id)).toBe(true);
    });
    db.close();
  });
});

describe("webapp：报告导出与证据透出", () => {
  it("GET /api/research/jobs/:id 带 evidence；导出 .md 下载", async () => {
    const db = new Database(":memory:");
    const jobId = db.insertJob({ type: "research", name: "r",
      payload: '{"template":"district-research","topic":"T"}' });
    const runId = db.insertJobRun({ jobId, status: "success" });
    db.insertArtifact({ jobRunId: runId, kind: "report", title: "商圈研究：T",
      content: "# 报告\n[A1.1] 【来源/2026】【等级 A】 事实。来源：https://a.example/x" });
    await withApp(db, {}, async (base) => {
      const detail = await (await fetch(`${base}/api/research/jobs/${jobId}`)).json();
      expect(detail.evidence).toHaveLength(1);
      expect(detail.evidence[0].grade).toBe("A");

      const exp = await fetch(`${base}/api/export/report/${(db.conn.prepare("SELECT id FROM artifacts LIMIT 1").get() as { id: number }).id}`);
      expect(exp.status).toBe(200);
      expect(exp.headers.get("content-disposition")).toContain(".md");
      expect((await exp.text())).toContain("[A1.1]");
    });
    db.close();
  });
});

describe("webapp：总览聚合", () => {
  it("GET /api/overview 指标 + 待办", async () => {
    const db = new Database(":memory:");
    db.upsertSource({ url: "https://s.example", schemaType: "NewsItem", name: "S" });
    for (let i = 0; i < 3; i++) db.insertRun({ url: "https://s.example", status: "FETCH_ERROR", sourceId: 1 });
    db.insertRun({ url: "https://ad.example", status: "SUCCESS" }); // adhoc（无 source）
    db.insertJob({ type: "research", name: "r1", enabled: false });             // 待确认
    const j2 = db.insertJob({ type: "research", name: "r2", enabled: true });
    db.insertJobRun({ jobId: j2, status: "paused" });
    const j3 = db.insertJob({ type: "custom", name: "天气", enabled: true });
    void j3;
    await withApp(db, {}, async (base) => {
      const o = await (await fetch(`${base}/api/overview`)).json();
      expect(o.scenarios.research.pendingConfirm).toBe(1);
      expect(o.scenarios.research.paused).toBe(1);
      expect(o.scenarios.adhoc.today).toBe(1);
      expect(o.scenarios.custom.active).toBe(1);
      expect(o.todos.length).toBeGreaterThanOrEqual(3); // 待确认+暂停+坏源
    });
    db.close();
  });
});
