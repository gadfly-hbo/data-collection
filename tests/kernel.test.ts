import { describe, expect, it } from "vitest";

import { BudgetGuard } from "../src/budget.ts";
import { JobKernel, type JobExecutor, type JobRow } from "../src/jobs/kernel.ts";
import { JobStatus } from "../src/status.ts";
import { Database } from "../src/storage/db.ts";

function jobRow(over: Partial<JobRow> = {}): JobRow {
  return {
    id: 1, type: "source", name: "test", ref_id: 1,
    payload: "{}", schedule: '{"kind":"interval","interval_s":60}', enabled: 1,
    ...over,
  };
}

/** 记录型假执行器 */
function fakeExecutor(results: (object | Error)[] = [{ status: JobStatus.SUCCESS }]) {
  const calls: JobRow[] = [];
  const executor: JobExecutor = {
    type: "fake",
    async run(job) {
      calls.push(job);
      const r = results[Math.min(calls.length - 1, results.length - 1)];
      if (r instanceof Error) throw r;
      return r as never;
    },
  };
  return { executor, calls };
}

describe("jobs/kernel：runJob 生命周期", () => {
  it("成功：job_runs 写 running→success 终态与 tokens", async () => {
    const db = new Database(":memory:");
    const jobId = db.insertJob({ type: "fake", name: "t" });
    const { executor } = fakeExecutor([
      { status: JobStatus.SUCCESS, inputTokens: 10, outputTokens: 3 },
    ]);
    const kernel = new JobKernel(db, { fake: executor });
    const result = await kernel.runJob(jobRow({ id: jobId, type: "fake" }));
    expect(result.status).toBe(JobStatus.SUCCESS);
    const runs = db.conn.prepare("SELECT * FROM job_runs ORDER BY id").all() as Record<string, unknown>[];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("success");
    expect(runs[0].input_tokens).toBe(10);
    expect(runs[0].finished_at).toBeTruthy();
    db.close();
  });

  it("执行器抛异常：兑换 failed 终态入台账", async () => {
    const db = new Database(":memory:");
    const jobId = db.insertJob({ type: "fake" });
    const { executor } = fakeExecutor([new Error("boom")]);
    const kernel = new JobKernel(db, { fake: executor });
    const result = await kernel.runJob(jobRow({ id: jobId, type: "fake" }));
    expect(result.status).toBe(JobStatus.FAILED);
    expect(result.error).toContain("boom");
    const run = db.conn.prepare("SELECT * FROM job_runs").get() as Record<string, unknown>;
    expect(run.status).toBe("failed");
    db.close();
  });

  it("无执行器类型：failed 且不派发", async () => {
    const db = new Database(":memory:");
    const jobId = db.insertJob({ type: "nope" });
    const kernel = new JobKernel(db, {});
    const result = await kernel.runJob(jobRow({ id: jobId, type: "nope" }));
    expect(result.status).toBe(JobStatus.FAILED);
    expect(result.error).toContain("无 nope 类型的执行器");
    db.close();
  });

  it("预算熔断：记 skipped，执行器不被调用", async () => {
    const db = new Database(":memory:");
    const jobId = db.insertJob({ type: "fake" });
    const budget = new BudgetGuard(db, 0, 999999);
    const { executor, calls } = fakeExecutor();
    const kernel = new JobKernel(db, { fake: executor }, budget);
    const result = await kernel.runJob(jobRow({ id: jobId, type: "fake" }));
    expect(result.status).toBe(JobStatus.SKIPPED);
    expect(calls).toHaveLength(0);
    const run = db.conn.prepare("SELECT * FROM job_runs").get() as Record<string, unknown>;
    expect(run.status).toBe("skipped");
    db.close();
  });
});

describe("jobs/kernel：tick 调度", () => {
  function setup(results: (object | Error)[] = [{ status: JobStatus.SUCCESS }]) {
    const db = new Database(":memory:");
    const id1 = db.insertJob({ type: "fake", name: "a", schedule: '{"kind":"interval","interval_s":60}' });
    db.insertJob({ type: "fake", name: "b", schedule: '{"kind":"interval","interval_s":60}', enabled: false });
    const fake = fakeExecutor(results);
    let now = 1_000_000;
    const kernel = new JobKernel(db, { fake: fake.executor }, null, () => now);
    return { db, kernel, fake, id1, setNow: (t: number) => (now = t) };
  }

  it("只调度启用任务；间隔内不重复；改间隔下个 tick 生效", async () => {
    const { db, kernel, fake, setNow } = setup();
    await kernel.tick();
    expect(fake.calls.map((j) => j.name)).toEqual(["a"]); // 停用任务不调度

    await kernel.tick(); // 未到期
    setNow(1_030_000);
    await kernel.tick();
    expect(fake.calls).toHaveLength(1);

    setNow(1_061_000); // 超过 60s
    await kernel.tick();
    expect(fake.calls).toHaveLength(2);

    db.setJobEnabled(0 as never, true); // noop 安全
    db.close();
  });

  it("串行执行：到期任务按顺序逐个跑", async () => {
    const db = new Database(":memory:");
    db.insertJob({ type: "fake", name: "a" });
    db.insertJob({ type: "fake", name: "b" });
    const order: string[] = [];
    const executor: JobExecutor = {
      type: "fake",
      async run(job) {
        order.push(`start:${job.name}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end:${job.name}`);
        return { status: JobStatus.SUCCESS } as never;
      },
    };
    await new JobKernel(db, { fake: executor }).tick();
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    db.close();
  });
});
