import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Database, retryOnBusy } from "../src/storage/db.ts";

describe("切片1：并发写加固", () => {
  it("busy_timeout 生效（5000ms）", () => {
    const dir = mkdtempSync(join(tmpdir(), "dc-busy-"));
    const db = new Database(join(dir, "c.db"));
    const v = db.conn.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(v.timeout).toBeGreaterThanOrEqual(5000);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("retryOnBusy：SQLITE_BUSY 重试一次后成功；非 busy 立即抛出", () => {
    let calls = 0;
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const result = retryOnBusy(() => {
      calls++;
      if (calls === 1) throw busy;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);

    let calls2 = 0;
    expect(() => retryOnBusy(() => { calls2++; throw new Error("constraint failed"); })).toThrow("constraint");
    expect(calls2).toBe(1);

    let calls3 = 0;
    expect(() => retryOnBusy(() => { calls3++; throw busy; })).toThrow(/locked/);
    expect(calls3).toBe(2); // 穷尽后上抛
  });

  it("webapp 写端点在首次 BUSY 后仍成功", async () => {
    const { Database: _D } = await import("../src/storage/db.ts");
    const db = new _D(":memory:");
    const real = db.upsertSource.bind(db);
    let threw = false;
    (db as unknown as { upsertSource: (i: never) => number }).upsertSource = (input) => {
      if (!threw) {
        threw = true;
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return real(input as never);
    };
    const { createApp } = await import("../scripts/webapp.ts");
    const ctx = { kernel: null, pipeline: { run: async () => null }, fetcher: null,
                  db, notifyEnabled: false, tickS: 30 } as never;
    const app = createApp(ctx, db, { withScheduler: false });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    const resp = await fetch(`http://127.0.0.1:${port}/api/sources`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://busy.example", schema_type: "NewsItem" }),
    });
    expect(resp.status).toBe(200);
    server.close();
    db.close();
  });
});
