import { describe, expect, it } from "vitest";

import { DedupGate } from "../src/dedup.ts";
import { RunStatus } from "../src/status.ts";
import { Database } from "../src/storage/db.ts";

const URL_A = "https://a.example/story";
const URL_B = "https://b.example/story";
const HASH_1 = "ab".repeat(32);
const HASH_2 = "cd".repeat(32);

function recordSuccess(db: Database, url: string, rawHash: string, schemaType = "NewsItem"): void {
  const runId = db.insertRun({ url, status: RunStatus.SUCCESS, rawHash });
  db.insertItem({
    runId,
    sourceUrl: url,
    schemaType,
    content: '{"title": "t"}',
    dedupHash: `${rawHash.slice(0, 30)}${schemaType}`,
  });
}

describe("dedup 去重闸门", () => {
  it("同 URL 同哈希同 Schema 命中", () => {
    const db = new Database(":memory:");
    const gate = new DedupGate(db);
    expect(gate.seen(URL_A, HASH_1, "NewsItem")).toBe(false);
    recordSuccess(db, URL_A, HASH_1);
    expect(gate.seen(URL_A, HASH_1, "NewsItem")).toBe(true);
    db.close();
  });

  it("失败记录不命中（内容未变也应重试提取）", () => {
    const db = new Database(":memory:");
    const gate = new DedupGate(db);
    db.insertRun({ url: URL_A, status: RunStatus.SCHEMA_ERROR, rawHash: HASH_1, inputTokens: 80 });
    expect(gate.seen(URL_A, HASH_1, "NewsItem")).toBe(false);
    db.close();
  });

  it("同 URL 新哈希不命中；不同 URL 同哈希不互相干扰", () => {
    const db = new Database(":memory:");
    const gate = new DedupGate(db);
    recordSuccess(db, URL_A, HASH_1);
    expect(gate.seen(URL_A, HASH_2, "NewsItem")).toBe(false);
    expect(gate.seen(URL_B, HASH_1, "NewsItem")).toBe(false);
    db.close();
  });

  it("改配 Schema 后按新 Schema 重新提取", () => {
    const db = new Database(":memory:");
    const gate = new DedupGate(db);
    recordSuccess(db, URL_A, HASH_1, "NewsItem");
    expect(gate.seen(URL_A, HASH_1, "CompetitorEvent")).toBe(false);
    db.close();
  });
});
