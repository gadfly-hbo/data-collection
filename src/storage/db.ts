/** SQLite 初始化与写入接口：三张核心表 + schema_version（node:sqlite）。
 *  单 Worker 串行写入（AGENTS.md 硬性规则）：一个 Database 实例一个连接全进程复用。 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_REGISTRY } from "../models/schemas.ts";

export const SCHEMA_VERSION = 2;
export const MIN_INTERVAL_S = 60; // 来源调度间隔下限（秒）

const DDL = `
CREATE TABLE IF NOT EXISTS sources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT NOT NULL UNIQUE,
    name        TEXT,
    schema_type TEXT NOT NULL,
    interval_s  INTEGER DEFAULT 3600,
    enabled     INTEGER DEFAULT 1,
    use_browser INTEGER NOT NULL DEFAULT 0,
    instruction TEXT NOT NULL DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crawl_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id      INTEGER REFERENCES sources(id),
    url            TEXT NOT NULL,
    raw_hash       TEXT,
    status         TEXT NOT NULL,
    provider       TEXT,
    model          TEXT,
    input_tokens   INTEGER,
    output_tokens  INTEGER,
    duration_ms    INTEGER,
    error_msg      TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS extracted_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER REFERENCES crawl_runs(id),
    source_url  TEXT NOT NULL,
    schema_type TEXT NOT NULL,
    content     TEXT NOT NULL,
    dedup_hash  TEXT UNIQUE,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_version (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    version    INTEGER NOT NULL,
    applied_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runs_dedup ON crawl_runs (url, raw_hash, status);
CREATE INDEX IF NOT EXISTS idx_runs_created ON crawl_runs (created_at);
CREATE INDEX IF NOT EXISTS idx_items_run ON extracted_items (run_id);
CREATE INDEX IF NOT EXISTS idx_items_schema ON extracted_items (schema_type);
`;

/** 已发布版本的增量迁移：key = 迁移到的版本号 */
const MIGRATIONS: Record<number, string[]> = {
  2: [
    "ALTER TABLE sources ADD COLUMN use_browser INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sources ADD COLUMN instruction TEXT NOT NULL DEFAULT ''",
  ],
};

export interface SourceInput {
  url: string;
  schemaType: string;
  name?: string | null;
  intervalS?: number;
  enabled?: boolean;
  useBrowser?: boolean;
  instruction?: string;
}

export function validateSource(url: string, schemaType: string, intervalS: number): void {
  if (!/^https?:\/\/.+\..+/.test(url)) throw new Error(`非法 URL：${url}`);
  if (!SCHEMA_REGISTRY[schemaType]) {
    throw new Error(`未知 schema_type: ${schemaType}（可用值：${Object.keys(SCHEMA_REGISTRY).join(", ")}）`);
  }
  if (intervalS < MIN_INTERVAL_S) {
    throw new Error(`interval_s 不得低于 ${MIN_INTERVAL_S}s（当前 ${intervalS}）`);
  }
}

export class Database {
  readonly conn: DatabaseSync;

  constructor(path: string = "data/collector.db") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.conn = new DatabaseSync(path);
    this.conn.exec("PRAGMA foreign_keys = ON");
    this.conn.exec("PRAGMA journal_mode = WAL"); // 面板只读连接与采集写并发
    this.initSchema();
  }

  private columns(table: string): Set<string> {
    const rows = this.conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  }

  private applyMigration(version: number): void {
    // 单个版本的迁移语句与版本戳放进同一事务（SQLite 支持事务性 DDL）
    this.conn.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of MIGRATIONS[version]) this.conn.exec(statement);
      this.conn.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
      this.conn.exec("COMMIT");
    } catch (e) {
      this.conn.exec("ROLLBACK");
      throw e;
    }
  }

  private initSchema(): void {
    this.conn.exec(DDL);
    const row = this.conn
      .prepare("SELECT MAX(version) AS v FROM schema_version")
      .get() as { v: number | null };
    if (row.v === null) {
      // 无版本行：全新库直接登记当前版本；遗留库（缺新列）先补齐迁移
      if (!this.columns("sources").has("use_browser")) this.applyMigration(2);
      this.conn
        .prepare("INSERT INTO schema_version (version) VALUES (?)")
        .run(SCHEMA_VERSION);
      return;
    }
    if (row.v > SCHEMA_VERSION) {
      throw new Error(`数据库 schema 版本 ${row.v} 高于代码支持的 ${SCHEMA_VERSION}，请升级程序`);
    }
    for (let v = row.v + 1; v <= SCHEMA_VERSION; v++) this.applyMigration(v);
  }

  close(): void {
    this.conn.close();
  }

  // ---------- sources ----------

  upsertSource(input: SourceInput): number {
    const intervalS = input.intervalS ?? 3600;
    validateSource(input.url, input.schemaType, intervalS);
    this.conn
      .prepare(
        `INSERT INTO sources (url, name, schema_type, interval_s, enabled, use_browser, instruction)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET name = excluded.name,
           schema_type = excluded.schema_type, interval_s = excluded.interval_s,
           enabled = excluded.enabled, use_browser = excluded.use_browser,
           instruction = excluded.instruction`,
      )
      .run(
        input.url,
        input.name ?? null,
        input.schemaType,
        intervalS,
        input.enabled === false ? 0 : 1,
        input.useBrowser ? 1 : 0,
        input.instruction ?? "",
      );
    return (this.getSource(input.url) as { id: number }).id;
  }

  getSource(url: string): Record<string, unknown> | undefined {
    return this.conn.prepare("SELECT * FROM sources WHERE url = ?").get(url) as
      | Record<string, unknown>
      | undefined;
  }

  deleteSource(id: number): boolean {
    // 存在关联台账时抛 IntegrityError（node:sqlite 报 constraint），调用方应改为停用
    return this.conn.prepare("DELETE FROM sources WHERE id = ?").run(id).changes > 0;
  }

  // ---------- crawl_runs ----------

  insertRun(r: {
    url: string;
    status: string;
    sourceId?: number | null;
    rawHash?: string | null;
    provider?: string | null;
    model?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
    errorMsg?: string | null;
  }): number {
    const res = this.conn
      .prepare(
        `INSERT INTO crawl_runs (url, status, source_id, raw_hash, provider,
           model, input_tokens, output_tokens, duration_ms, error_msg)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.url, r.status, r.sourceId ?? null, r.rawHash ?? null, r.provider ?? null,
        r.model ?? null, r.inputTokens ?? 0, r.outputTokens ?? 0,
        r.durationMs ?? 0, r.errorMsg ?? null,
      );
    return Number(res.lastInsertRowid);
  }

  // ---------- extracted_items ----------

  insertItem(r: {
    runId: number;
    sourceUrl: string;
    schemaType: string;
    content: string;
    dedupHash: string;
  }): number | null {
    const res = this.conn
      .prepare(
        `INSERT OR IGNORE INTO extracted_items
           (run_id, source_url, schema_type, content, dedup_hash) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(r.runId, r.sourceUrl, r.schemaType, r.content, r.dedupHash);
    return res.changes > 0 ? Number(res.lastInsertRowid) : null;
  }
}
