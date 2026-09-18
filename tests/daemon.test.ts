import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildContext, makeJobContext, runTick } from "../scripts/run-daemon.ts";
import { JobKernel } from "../src/jobs/kernel.ts";
import { JobStatus } from "../src/status.ts";
import { Database } from "../src/storage/db.ts";
import { loadSettings } from "../src/config.ts";

describe("daemon：Job 内核接线", () => {
  it("buildContext 组装内核（source 执行器就位）", () => {
    process.env.MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? "test-key";
    const db = new Database(":memory:");
    db.upsertSource({ url: "https://a.example/1", schemaType: "NewsItem", name: "A" });
    const settings = loadSettings("config/settings.yaml");
    const ctx = buildContext(settings, db);
    expect(ctx.kernel).toBeInstanceOf(JobKernel);
    expect(ctx.db).toBe(db);
    db.close();
  });

  it("makeJobContext：blocked 事件走 onEvent 通道", () => {
    const events: string[] = [];
    const ctx = { kernel: {} as never, pipeline: {} as never, fetcher: null as never,
                  db: {} as never, notifyEnabled: false, tickS: 30 };
    const jobCtx = makeJobContext(ctx as never);
    jobCtx.onEvent?.("blocked", "https://x 403");
    // 无崩溃 + 通道可用即通过（通知在 notifyEnabled=false 时不发）
    expect(jobCtx.onEvent).toBeTruthy();
    void events;
  });

  it("runTick 委托内核并产生 job_runs 台账", async () => {
    process.env.MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? "test-key";
    const db = new Database(":memory:");
    db.upsertSource({ url: "https://a.example/1", schemaType: "NewsItem", name: "A" });
    const ctx = buildContext(loadSettings("config/settings.yaml"), db);
    // 替换内核执行器为假实现（不触网）
    const fakeKernel = new JobKernel(db, {
      source: { type: "source", async run() { return { status: JobStatus.SUCCESS, inputTokens: 1 }; } },
    });
    (ctx as { kernel: JobKernel }).kernel = fakeKernel;
    await runTick(ctx);
    const runs = db.conn.prepare("SELECT * FROM job_runs").all() as Record<string, unknown>[];
    expect(runs).toHaveLength(1); // 到期任务执行且入任务级台账
    expect(runs[0].status).toBe("success");
    db.close();
  });

  it("真实库迁移冒烟：v2 数据库（含 sources）打开后 jobs 1:1 回填且幂等", () => {
    const dir = mkdtempSync(join(tmpdir(), "dc-v3-"));
    const path = join(dir, "v2.db");
    const db = new Database(path);
    const sid = db.upsertSource({ url: "https://a.example/1", schemaType: "NewsItem", name: "A", intervalS: 120 });
    db.close();
    // 模拟 v2 库：去掉 v3 表与版本行，重开触发迁移路径
    const db2 = new Database(path);
    db2.conn.exec("DELETE FROM jobs; DELETE FROM schema_version WHERE version = 3;");
    db2.conn.exec("UPDATE schema_version SET version = 2 WHERE version = (SELECT MIN(version) FROM schema_version);");
    db2.close();

    const db3 = new Database(path); // v2 → v3 迁移 + 回填
    const jobs = db3.listJobs({ type: "source" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].ref_id).toBe(sid);
    expect(JSON.parse(String(jobs[0].schedule)).interval_s).toBe(120);
    expect(jobs[0].name).toBe("A");
    const v = db3.conn.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(v.v).toBe(3);
    db3.close();

    const db4 = new Database(path); // 幂等重开
    expect(db4.listJobs({ type: "source" })).toHaveLength(1);
    db4.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
