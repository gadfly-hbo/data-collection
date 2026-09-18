/** SQLite 初始化与写入接口：核心表 + schema_version（node:sqlite）。
 *  v3 起：jobs / job_runs / artifacts（统一 Job 内核，见 PLAN §11）。
 *  单 Worker 串行写入（AGENTS.md 硬性规则）：一个 Database 实例一个连接全进程复用。 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_REGISTRY } from "../models/schemas.ts";

export const SCHEMA_VERSION = 3;
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

-- ── v3：统一 Job 内核（PLAN §11）──
CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,               -- 'source' | 'custom' | 'research'
    name       TEXT,
    ref_id     INTEGER,                     -- type=source → sources.id（payload 子表）
    payload    TEXT NOT NULL DEFAULT '{}',  -- type!=source 的配置（per-type 校验）
    schedule   TEXT NOT NULL DEFAULT '{"kind":"interval","interval_s":3600}',
    enabled    INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_ref ON jobs (type, ref_id)
    WHERE ref_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        INTEGER REFERENCES jobs(id),
    status        TEXT NOT NULL,            -- JobStatus: running/success/failed/paused/skipped
    node_state    TEXT,                     -- research：节点状态快照（断点续跑）
    input_tokens  INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    error         TEXT,
    started_at    TEXT DEFAULT (datetime('now')),
    finished_at   TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_run_id  INTEGER REFERENCES job_runs(id),
    kind        TEXT NOT NULL,              -- 'report' | 'dataset'（item 由 extracted_items 承担）
    title       TEXT,
    content     TEXT NOT NULL,
    meta        TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runs_dedup ON crawl_runs (url, raw_hash, status);
CREATE INDEX IF NOT EXISTS idx_runs_created ON crawl_runs (created_at);
CREATE INDEX IF NOT EXISTS idx_items_run ON extracted_items (run_id);
CREATE INDEX IF NOT EXISTS idx_items_schema ON extracted_items (schema_type);
CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs (job_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts (job_run_id);
`;

/** 已发布版本的增量迁移：key = 迁移到的版本号 */
const MIGRATIONS: Record<number, string[]> = {
  2: [
    "ALTER TABLE sources ADD COLUMN use_browser INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sources ADD COLUMN instruction TEXT NOT NULL DEFAULT ''",
  ],
  3: [
    // sources → jobs 1:1 回填（幂等：type×ref_id 唯一索引 + OR IGNORE）
    `INSERT OR IGNORE INTO jobs (type, name, ref_id, payload, schedule, enabled, created_at)
     SELECT 'source', COALESCE(name, url), id, '{}',
            json_object('kind', 'interval', 'interval_s', interval_s),
            enabled, created_at
     FROM sources`,
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
      this.applyMigration(3); // 全新库同样执行 sources 回填（幂等，空表无害）
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

  // ---------- sources（type=source 任务的 payload 子表） ----------

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
    const id = (this.getSource(input.url) as { id: number }).id;
    this.upsertSourceJob(id); // 来源与调度 job 保持 1:1（所有写路径统一）
    return id;
  }

  getSource(url: string): Record<string, unknown> | undefined {
    return this.conn.prepare("SELECT * FROM sources WHERE url = ?").get(url) as
      | Record<string, unknown>
      | undefined;
  }

  deleteSource(id: number): boolean {
    // 存在关联台账时抛 IntegrityError（node:sqlite 报 constraint），调用方应改为停用
    const deleted = this.conn.prepare("DELETE FROM sources WHERE id = ?").run(id).changes > 0;
    if (deleted) {
      // job 不删（保留历史 job_runs 关联），只停用调度
      this.conn
        .prepare("UPDATE jobs SET enabled = 0 WHERE type = 'source' AND ref_id = ?")
        .run(id);
    }
    return deleted;
  }

  // ---------- jobs（统一调度实体） ----------

  /** sources → jobs 1:1 同步（幂等；新建/更新来源后调用） */
  upsertSourceJob(sourceId: number): number {
    this.conn
      .prepare(
        `INSERT INTO jobs (type, name, ref_id, payload, schedule, enabled, created_at)
         SELECT 'source', COALESCE(name, url), id, '{}',
                json_object('kind', 'interval', 'interval_s', interval_s),
                enabled, created_at
         FROM sources WHERE id = ?
         ON CONFLICT(type, ref_id) WHERE ref_id IS NOT NULL DO UPDATE SET
           name = excluded.name, schedule = excluded.schedule,
           enabled = excluded.enabled`,
      )
      .run(sourceId)
      .toString();
    const row = this.conn
      .prepare("SELECT id FROM jobs WHERE type = 'source' AND ref_id = ?")
      .get(sourceId) as { id: number };
    return row.id;
  }

  insertJob(r: {
    type: string;
    name?: string | null;
    refId?: number | null;
    payload?: string;
    schedule?: string;
    enabled?: boolean;
  }): number {
    const res = this.conn
      .prepare(
        `INSERT INTO jobs (type, name, ref_id, payload, schedule, enabled)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.type, r.name ?? null, r.refId ?? null, r.payload ?? "{}",
        r.schedule ?? '{"kind":"interval","interval_s":3600}',
        r.enabled === false ? 0 : 1,
      );
    return Number(res.lastInsertRowid);
  }

  getJob(id: number): Record<string, unknown> | undefined {
    return this.conn.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
  }

  /** type=source 任务按 sources.id 反查（webapp 立即执行路径） */
  getSourceJob(sourceId: number): Record<string, unknown> | undefined {
    return this.conn
      .prepare("SELECT * FROM jobs WHERE type = 'source' AND ref_id = ?")
      .get(sourceId) as Record<string, unknown> | undefined;
  }

  listJobs(opts: { enabled?: boolean; type?: string } = {}): Record<string, unknown>[] {
    let sql = "SELECT * FROM jobs WHERE 1 = 1";
    const params: (string | number)[] = [];
    if (opts.enabled !== undefined) {
      sql += " AND enabled = ?";
      params.push(opts.enabled ? 1 : 0);
    }
    if (opts.type) {
      sql += " AND type = ?";
      params.push(opts.type);
    }
    return this.conn.prepare(`${sql} ORDER BY id`).all(...params) as Record<string, unknown>[];
  }

  setJobEnabled(id: number, enabled: boolean): void {
    this.conn.prepare("UPDATE jobs SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  // ---------- job_runs（任务级台账） ----------

  insertJobRun(r: { jobId: number; status: string; nodeState?: string | null }): number {
    const res = this.conn
      .prepare("INSERT INTO job_runs (job_id, status, node_state) VALUES (?, ?, ?)")
      .run(r.jobId, r.status, r.nodeState ?? null);
    return Number(res.lastInsertRowid);
  }

  updateJobRun(
    id: number,
    r: {
      status: string;
      inputTokens?: number;
      outputTokens?: number;
      error?: string | null;
      nodeState?: string | null;
    },
  ): void {
    this.conn
      .prepare(
        `UPDATE job_runs SET status = ?, input_tokens = ?, output_tokens = ?,
           error = ?, node_state = COALESCE(?, node_state),
           finished_at = datetime('now')
         WHERE id = ?`,
      )
      .run(r.status, r.inputTokens ?? 0, r.outputTokens ?? 0, r.error ?? null, r.nodeState ?? null, id);
  }

  // ---------- artifacts（report / dataset） ----------

  insertArtifact(r: {
    jobRunId: number;
    kind: string;
    title?: string | null;
    content: string;
    meta?: string | null;
  }): number {
    const res = this.conn
      .prepare(
        `INSERT INTO artifacts (job_run_id, kind, title, content, meta) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(r.jobRunId, r.kind, r.title ?? null, r.content, r.meta ?? null);
    return Number(res.lastInsertRowid);
  }

  // ---------- crawl_runs（采集动作级台账，口径不变） ----------

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
