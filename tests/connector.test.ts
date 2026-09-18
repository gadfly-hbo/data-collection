import { describe, expect, it } from "vitest";

import { WeatherConnector, getConnector, CONNECTOR_REGISTRY } from "../src/connectors/registry.ts";
import { CustomExecutor } from "../src/jobs/customExecutor.ts";
import type { JobRow } from "../src/jobs/kernel.ts";
import { JobStatus } from "../src/status.ts";
import { Database } from "../src/storage/db.ts";

function fakeFetcher(json: () => unknown) {
  return {
    async fetch() {
      return { status: "OK", url: "https://api.test/x", html: JSON.stringify(json()) };
    },
  } as never;
}

function weatherJson(times: string[]) {
  return {
    hourly: {
      time: times,
      temperature_2m: times.map((_, i) => 20 + i),
      precipitation: times.map(() => 0),
      wind_speed_10m: times.map(() => 5),
    },
  };
}

function jobRow(payload: unknown): JobRow {
  return { id: 1, type: "custom", name: "w", ref_id: null,
           payload: JSON.stringify(payload), schedule: '{"kind":"interval","interval_s":3600}',
           enabled: 1 };
}

describe("connectors/registry", () => {
  it("天气 connector：城市 zod 校验 + 行解析", async () => {
    const c = new WeatherConnector();
    expect(c.api).toBe(true);
    const rows = await c.fetchRows({ city: "深圳" }, { fetcher: fakeFetcher(() => weatherJson(["2026-09-18T01:00", "2026-09-18T02:00"])) });
    expect(rows).toHaveLength(2);
    expect(rows[0].values.temperature_2m).toBe(20);
    expect(() => c.fetchRows({ city: "不存在" }, { fetcher: fakeFetcher(() => ({})) })).rejects?.toBeTruthy();
  });

  it("未知 connector 拒绝", () => {
    expect(() => getConnector("nope")).toThrow(/未知 connector/);
    expect(Object.keys(CONNECTOR_REGISTRY)).toContain("weather");
  });
});

describe("jobs/customExecutor", () => {
  it("首次运行：全量行入 dataset artifact + 水位推进", async () => {
    const db = new Database(":memory:");
    const jobId = db.insertJob({ type: "custom", name: "w",
      payload: JSON.stringify({ connector: "weather", params: { city: "深圳" } }) });
    // 模拟 kernel：先建 running 的 job_runs（CustomExecutor 取最新行挂 artifact）
    db.insertJobRun({ jobId, status: "running" });
    const exec = new CustomExecutor(fakeFetcher(() => weatherJson(["T01", "T02"])));
    const result = await exec.run(jobRow({ connector: "weather", params: { city: "深圳" } }), { db });
    expect(result.status).toBe(JobStatus.SUCCESS);
    expect((result.detail as { rows: number }).rows).toBe(2);
    const arts = db.conn.prepare("SELECT * FROM artifacts WHERE kind = 'dataset'").all() as Record<string, unknown>[];
    expect(arts).toHaveLength(1);
    expect(JSON.parse(String(arts[0].content))).toHaveLength(2);
    // 水位已持久化
    expect(JSON.parse(String(db.getJob(jobId)!.payload))._wm).toBeTruthy();
    db.close();
  });

  it("增量去重：≤ 水位的行不再入库；connector 失败 → failed + onEvent", async () => {
    const db = new Database(":memory:");
    const j1 = db.insertJob({ type: "custom", name: "w" });
    db.insertJobRun({ jobId: j1, status: "running" });
    const exec = new CustomExecutor(fakeFetcher(() => weatherJson(["T01", "T02"])));
    const seen = await exec.run(jobRow({ connector: "weather", params: { city: "深圳" }, _wm: "T02" }), { db });
    expect(seen.status).toBe(JobStatus.SUCCESS);
    expect((seen.detail as { rows: number }).rows).toBe(0); // 全部 ≤ 水位
    expect(db.conn.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toMatchObject({ n: 0 });

    const events: string[] = [];
    const broken = new CustomExecutor({ async fetch() { return { status: "FETCH_ERROR", url: "", reason: "网络断" }; } } as never);
    const j2 = db.insertJob({ type: "custom", name: "w2" });
    db.insertJobRun({ jobId: j2, status: "running" });
    const r = await broken.run(jobRow({ connector: "weather", params: { city: "深圳" } }), { db, onEvent: (_k, m) => events.push(m) });
    expect(r.status).toBe(JobStatus.FAILED);
    expect(r.error).toContain("网络断");
    expect(events).toHaveLength(1);
    db.close();
  });
});
