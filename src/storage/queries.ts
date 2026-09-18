/** 只读分析查询：监控面板与 Web 控制台共用（全部 SELECT，无写路径）。 */
import { BILLABLE_STATUSES } from "../status.ts";
import type { Database } from "./db.ts";

export function statusSummary(db: Database) {
  const total = (db.conn.prepare("SELECT COUNT(*) AS n FROM crawl_runs").get() as { n: number }).n;
  const byStatus: Record<string, number> = {};
  for (const r of db.conn
    .prepare("SELECT status, COUNT(*) AS n FROM crawl_runs GROUP BY status")
    .all() as { status: string; n: number }[]) {
    byStatus[r.status] = r.n;
  }
  const placeholders = BILLABLE_STATUSES.map(() => "?").join(",");
  const today = db.conn
    .prepare(
      `SELECT COUNT(*) AS tasks, COALESCE(SUM(input_tokens), 0) AS tokens
       FROM crawl_runs WHERE status IN (${placeholders})
       AND substr(created_at, 1, 10) = date('now')`,
    )
    .get(...BILLABLE_STATUSES) as { tasks: number; tokens: number };
  const ok =
    (byStatus["SUCCESS"] ?? 0) +
    (byStatus["SKIPPED_UNCHANGED"] ?? 0) +
    (byStatus["SKIPPED_NO_CONTENT"] ?? 0);
  return {
    total,
    by_status: byStatus,
    success_rate: total ? ok / total : 0,
    today_tasks: today.tasks,
    today_input_tokens: today.tokens,
  };
}

export function dailyTokens(db: Database, days = 30) {
  const placeholders = BILLABLE_STATUSES.map(() => "?").join(",");
  return db.conn
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS tasks,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM crawl_runs WHERE status IN (${placeholders})
       GROUP BY day ORDER BY day DESC LIMIT ?`,
    )
    .all(...BILLABLE_STATUSES, days);
}

export function blockedSources(db: Database, limit = 50) {
  return db.conn
    .prepare(
      `SELECT url, error_msg, created_at FROM crawl_runs
       WHERE status = 'BLOCKED' ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);
}

export function listSourcesWithLastRun(db: Database) {
  return db.conn
    .prepare(
      `SELECT s.*,
         (SELECT r.status FROM crawl_runs r WHERE r.source_id = s.id
          ORDER BY r.id DESC LIMIT 1) AS last_status,
         (SELECT MAX(r.created_at) FROM crawl_runs r WHERE r.source_id = s.id) AS last_run_at
       FROM sources s ORDER BY s.id`,
    )
    .all();
}

export function recentRuns(db: Database, limit = 50) {
  return db.conn
    .prepare(
      `SELECT id, url, status, provider, model, input_tokens, output_tokens,
         duration_ms, error_msg, created_at FROM crawl_runs ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);
}

export function queryItems(
  db: Database,
  opts: { schemaType?: string; keyword?: string; since?: string; until?: string; limit?: number; offset?: number } = {},
): { rows: unknown[]; total: number } {
  let sql = "FROM extracted_items WHERE 1 = 1";
  const params: (string | number)[] = [];
  if (opts.schemaType) {
    sql += " AND schema_type = ?";
    params.push(opts.schemaType);
  }
  if (opts.keyword) {
    sql += " AND (content LIKE ? OR source_url LIKE ?)";
    params.push(`%${opts.keyword}%`, `%${opts.keyword}%`);
  }
  if (opts.since) {
    sql += " AND date(created_at) >= date(?)";
    params.push(opts.since);
  }
  if (opts.until) {
    sql += " AND date(created_at) <= date(?)";
    params.push(opts.until);
  }
  const total = (db.conn.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...params) as { n: number }).n;
  const rows = db.conn
    .prepare(
      `SELECT id, run_id, source_url, schema_type, content, created_at ${sql}
       ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit ?? 200, opts.offset ?? 0) as Record<string, unknown>[];
  // content 解析为 item；解析失败降级为 _raw
  const items = rows.map((r) => {
    let item: unknown;
    try {
      item = JSON.parse(r.content as string);
    } catch {
      item = { _raw: r.content };
    }
    return {
      id: r.id, run_id: r.run_id, source_url: r.source_url,
      schema_type: r.schema_type, created_at: r.created_at, item,
    };
  });
  return { rows: items, total };
}
