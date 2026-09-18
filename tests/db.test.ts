import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { Database, MIN_INTERVAL_S, SCHEMA_VERSION } from "../src/storage/db.ts";

const dbs: Database[] = [];
function mem(): Database {
  const db = new Database(":memory:");
  dbs.push(db);
  return db;
}
afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
});

describe("storage/db", () => {
  it("建库幂等且重开不丢数据（含 schema_version）", () => {
    const dir = mkdtempSync(join(tmpdir(), "dc-test-"));
    const path = join(dir, "c.db");
    const db1 = new Database(path);
    const id = db1.upsertSource({ url: "https://a.example", schemaType: "NewsItem", name: "A" });
    db1.close();

    const db2 = new Database(path);
    expect((db2.getSource("https://a.example") as { id: number }).id).toBe(id);
    const v = db2.conn.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(v.v).toBe(SCHEMA_VERSION);
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("upsert 幂等更新：同 url 不产生第二行", () => {
    const db = mem();
    const id1 = db.upsertSource({ url: "https://a.example", schemaType: "NewsItem", name: "旧", intervalS: 3600 });
    const id2 = db.upsertSource({ url: "https://a.example", schemaType: "NewsItem", name: "新", intervalS: 60, enabled: false });
    expect(id2).toBe(id1);
    const row = db.getSource("https://a.example") as { name: string; interval_s: number; enabled: number };
    expect(row.name).toBe("新");
    expect(row.interval_s).toBe(60);
    expect(row.enabled).toBe(0);
  });

  it("来源配置校验：非法 URL / 未知 schema / 间隔下限", () => {
    const db = mem();
    expect(() => db.upsertSource({ url: "ftp://x.example", schemaType: "NewsItem" })).toThrow(/URL/);
    expect(() => db.upsertSource({ url: "https://a.example", schemaType: "Nope" })).toThrow(/schema_type/);
    expect(() =>
      db.upsertSource({ url: "https://a.example", schemaType: "NewsItem", intervalS: MIN_INTERVAL_S - 1 }),
    ).toThrow(/interval_s/);
  });

  it("insert_run / insert_item 往返 + dedup_hash 唯一忽略", () => {
    const db = mem();
    const runId = db.insertRun({ url: "https://a.example/1", status: "SUCCESS", inputTokens: 100, durationMs: 5 });
    const h = "ab".repeat(32);
    const first = db.insertItem({ runId, sourceUrl: "https://a.example/1", schemaType: "NewsItem", content: "{}", dedupHash: h });
    const dup = db.insertItem({ runId, sourceUrl: "https://a.example/1", schemaType: "NewsItem", content: "{}", dedupHash: h });
    expect(first).not.toBeNull();
    expect(dup).toBeNull();
    const c = db.conn.prepare("SELECT COUNT(*) AS n FROM extracted_items").get() as { n: number };
    expect(c.n).toBe(1);
  });

  it("外键强制：item 引用不存在的 run 抛错；有关联台账的来源不可删", () => {
    const db = mem();
    expect(() =>
      db.insertItem({ runId: 999, sourceUrl: "https://x", schemaType: "NewsItem", content: "{}", dedupHash: "ee".repeat(32) }),
    ).toThrow(/FOREIGN KEY/);
    const sid = db.upsertSource({ url: "https://a.example", schemaType: "NewsItem" });
    db.insertRun({ url: "https://a.example", status: "SUCCESS", sourceId: sid });
    expect(() => db.deleteSource(sid)).toThrow();
    expect(db.deleteSource(999)).toBe(false);
  });

  it("v1 遗留库（无版本行）打开时按缺列检测补迁移", () => {
    const dir = mkdtempSync(join(tmpdir(), "dc-legacy-"));
    const path = join(dir, "old.db");
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE,
        name TEXT, schema_type TEXT NOT NULL, interval_s INTEGER DEFAULT 3600,
        enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO sources (url, schema_type, name) VALUES ('https://old.example', 'NewsItem', '遗留');
    `);
    raw.close();

    const db = new Database(path);
    const row = db.getSource("https://old.example") as { use_browser: number; instruction: string };
    expect(row.use_browser).toBe(0);
    expect(row.instruction).toBe("");
    const v = db.conn.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(v.v).toBe(SCHEMA_VERSION);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("WAL 模式生效（文件库）", () => {
    const dir = mkdtempSync(join(tmpdir(), "dc-wal-"));
    const db = new Database(join(dir, "w.db"));
    const mode = (db.conn.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    expect(mode).toBe("wal");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("storage/db v3：jobs 统一调度", () => {
  it("upsertSource 同步创建 1:1 job；改间隔同步 schedule；幂等不重复", () => {
    const db = mem();
    const sid = db.upsertSource({ url: "https://a.example/1", schemaType: "NewsItem", name: "A", intervalS: 120 });
    let jobs = db.listJobs({ type: "source" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].ref_id).toBe(sid);
    expect(JSON.parse(String(jobs[0].schedule))).toEqual({ kind: "interval", interval_s: 120 });

    db.upsertSource({ url: "https://a.example/1", schemaType: "NewsItem", name: "A", intervalS: 3600 });
    jobs = db.listJobs({ type: "source" });
    expect(jobs).toHaveLength(1); // 同一来源不产生第二个 job
    expect(JSON.parse(String(jobs[0].schedule)).interval_s).toBe(3600); // 间隔已同步
    expect(jobs[0].name).toBe("A");
  });

  it("deleteSource 停用对应 job（保留行供历史 job_runs 关联）", () => {
    const db = mem();
    const sid = db.upsertSource({ url: "https://a.example/1", schemaType: "NewsItem" });
    db.insertRun({ url: "https://a.example/1", status: "SUCCESS", sourceId: sid }); // 有关联台账
    expect(() => db.deleteSource(sid)).toThrow(); // 不可删
    // 无台账来源可删 → job 停用
    const sid2 = db.upsertSource({ url: "https://b.example/2", schemaType: "NewsItem" });
    expect(db.deleteSource(sid2)).toBe(true);
    const job = db.getSourceJob(sid2) as { enabled: number };
    expect(job.enabled).toBe(0);
  });

  it("job_runs / artifacts 写入接口", () => {
    const db = mem();
    const jobId = db.insertJob({ type: "research", name: "r", payload: '{"topic":"x"}' });
    const runId = db.insertJobRun({ jobId, status: "running", nodeState: '{"node":1}' });
    db.updateJobRun(runId, { status: "paused", nodeState: '{"node":2}', inputTokens: 100 });
    const run = db.conn.prepare("SELECT * FROM job_runs WHERE id = ?").get(runId) as Record<string, unknown>;
    expect(run.status).toBe("paused");
    expect(run.node_state).toBe('{"node":2}');
    expect(run.finished_at).toBeTruthy();
    const artId = db.insertArtifact({ jobRunId: runId, kind: "report", title: "t", content: "# 报告" });
    expect(artId).toBeGreaterThan(0);
  });

  it("全新库直建 v3（jobs 表存在且为空）", () => {
    const db = mem();
    expect(db.listJobs()).toEqual([]);
    const v = db.conn.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(v.v).toBe(3);
  });
});
