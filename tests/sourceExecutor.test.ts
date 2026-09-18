import { describe, expect, it } from "vitest";

import { SourceExecutor } from "../src/jobs/sourceExecutor.ts";
import type { JobContext, JobRow } from "../src/jobs/kernel.ts";
import type { RunOutcome } from "../src/pipeline.ts";
import { RunStatus } from "../src/status.ts";
import { Database } from "../src/storage/db.ts";

function outcome(status: RunStatus, over: Partial<RunOutcome> = {}): RunOutcome {
  return { status, url: "https://a.example/1", inputTokens: 5, outputTokens: 2,
           provider: "fake", model: "m", durationMs: 10, ...over };
}

function jobRow(over: Partial<JobRow> = {}): JobRow {
  return { id: 1, type: "source", name: "s", ref_id: 1, payload: "{}",
           schedule: '{"kind":"interval","interval_s":3600}', enabled: 1, ...over };
}

function setup(pipeline: unknown) {
  const db = new Database(":memory:");
  db.upsertSource({ url: "https://a.example/1", schemaType: "NewsItem", name: "A" });
  const ctx: JobContext = { db };
  return { db, ctx, executor: new SourceExecutor(pipeline as never) };
}

describe("jobs/sourceExecutor", () => {
  it("SUCCESS → job success，detail 透传 RunOutcome", async () => {
    const seen: unknown[] = [];
    const pipeline = { run: async (t: unknown) => { seen.push(t); return outcome(RunStatus.SUCCESS, { runId: 9 }); } };
    const { db, ctx, executor } = setup(pipeline);
    const result = await executor.run(jobRow(), ctx);
    expect(result.status).toBe("success");
    expect((result.detail as RunOutcome).runId).toBe(9);
    expect((seen[0] as { sourceId: number }).sourceId).toBe(1); // ref_id → sources 行透传
    db.close();
  });

  it("SKIPPED_* → job success；FETCH_ERROR/BLOCKED → job failed", async () => {
    for (const [run, jobExpected] of [
      [RunStatus.SKIPPED_UNCHANGED, "success"],
      [RunStatus.SKIPPED_NO_CONTENT, "success"],
      [RunStatus.FETCH_ERROR, "failed"],
      [RunStatus.BLOCKED, "failed"],
    ] as const) {
      const pipeline = { run: async () => outcome(run, { error: "x" }) };
      const { db, ctx, executor } = setup(pipeline);
      expect((await executor.run(jobRow(), ctx)).status).toBe(jobExpected);
      db.close();
    }
  });

  it("BLOCKED / 失败触发 onEvent；getSchema 异常写 crawl_runs 并 failed", async () => {
    // BLOCKED 告警
    const events: [string, string][] = [];
    const blocked = setup({ run: async () => outcome(RunStatus.BLOCKED, { error: "403" }) });
    await blocked.executor.run(jobRow(), { db: blocked.db, onEvent: (k, m) => events.push([k, m]) });
    expect(events[0][0]).toBe("blocked");
    blocked.db.close();

    // 非法 schema_type（pipeline 外异常）：crawl_runs 补记 + failed
    const ledger: string[] = [];
    const bad = setup({
      run: async () => outcome(RunStatus.SUCCESS),
    });
    bad.db.conn
      .prepare("UPDATE sources SET schema_type = 'Nope' WHERE id = 1")
      .run();
    const badPipeline = {
      run: async () => outcome(RunStatus.SUCCESS),
      ledger: { record: (o: RunOutcome) => (ledger.push(o.status), 1) },
    };
    const badExecutor = new SourceExecutor(badPipeline as never);
    const r = await badExecutor.run(jobRow(), { db: bad.db });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("Nope");
    expect(ledger).toEqual(["FETCH_ERROR"]); // 硬性规则：异常路径入动作级台账
    bad.db.close();
  });

  it("ref_id 缺失或 sources 行不存在 → failed", async () => {
    const { db, ctx, executor } = setup({ run: async () => outcome(RunStatus.SUCCESS) });
    expect((await executor.run(jobRow({ ref_id: null }), ctx)).status).toBe("failed");
    expect((await executor.run(jobRow({ ref_id: 999 }), ctx)).status).toBe("failed");
    db.close();
  });
});
