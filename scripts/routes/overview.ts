/** 总览 + Schema 注册表 + 摘要 + 运行记录 */
import type { Express } from "express";
import { SCHEMA_REGISTRY } from "../../src/models/schemas.ts";
import type { Database } from "../../src/storage/db.ts";
import * as queries from "../../src/storage/queries.ts";
import { zodDescription } from "./helpers.ts";

export function registerOverviewRoutes(app: Express, db: Database): void {
  app.get("/api/schemas", (_req, res) => {
    const out: Record<string, { description: string; fields: Record<string, string> }> = {};
    for (const [name, schema] of Object.entries(SCHEMA_REGISTRY)) {
      const shape = (schema as { _def?: { shape?: () => Record<string, unknown> } })._def?.shape?.() ?? {};
      const fields: Record<string, string> = {};
      for (const [field, fieldSchema] of Object.entries(shape)) {
        if (field === "source_url" || field === "scraped_at") continue;
        fields[field] = zodDescription(fieldSchema);
      }
      out[name] = { description: zodDescription(schema), fields };
    }
    res.json(out);
  });

  app.get("/api/summary", (_req, res) => {
    res.json({ summary: queries.statusSummary(db), daily: queries.dailyTokens(db, 14),
               blocked: queries.blockedSources(db, 10) });
  });

  app.get("/api/runs", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    res.json(queries.recentRuns(db, limit));
  });

  app.get("/api/overview", (_req, res) => {
    const q = (sql: string, ...args: unknown[]) => db.conn.prepare(sql).get(...args as never[]) as Record<string, number>;
    const today = q(`SELECT COUNT(*) AS n FROM crawl_runs WHERE substr(created_at,1,10)=date('now')`);
    const todayOk = q(`SELECT COUNT(*) AS n FROM crawl_runs WHERE substr(created_at,1,10)=date('now')
      AND status IN ('SUCCESS','SKIPPED_UNCHANGED','SKIPPED_NO_CONTENT')`);
    const tokens = q(`SELECT COALESCE(SUM(input_tokens+output_tokens),0) AS n FROM crawl_runs
      WHERE substr(created_at,1,10)=date('now') AND status IN ('SUCCESS','SCHEMA_ERROR')`);
    const pendingConfirm = q(`SELECT COUNT(*) AS n FROM jobs j WHERE j.type='research' AND j.enabled=0
      AND NOT EXISTS (SELECT 1 FROM job_runs r WHERE r.job_id = j.id)`).n;
    const paused = q(`SELECT COUNT(*) AS n FROM jobs j WHERE j.type='research'
      AND (SELECT r.status FROM job_runs r WHERE r.job_id=j.id ORDER BY r.id DESC LIMIT 1)='paused'`).n;
    const running = q(`SELECT COUNT(*) AS n FROM jobs j WHERE j.type='research'
      AND (SELECT r.status FROM job_runs r WHERE r.job_id=j.id ORDER BY r.id DESC LIMIT 1)='running'`).n;
    const adhoc = q(`SELECT COUNT(*) AS n FROM crawl_runs WHERE source_id IS NULL
      AND substr(created_at,1,10)=date('now')`).n;
    const badSources = db.conn.prepare(`
      SELECT s.id, s.name, s.url, COUNT(*) AS fails FROM crawl_runs c
      JOIN sources s ON s.id = c.source_id
      WHERE c.status IN ('FETCH_ERROR','BLOCKED') AND substr(c.created_at,1,10)=date('now')
      GROUP BY c.source_id HAVING fails >= 3 ORDER BY c.source_id LIMIT 10`).all() as { id: number; name: string | null; url: string; fails: number }[];
    const todos: { kind: string; text: string; link: string }[] = [];
    if (pendingConfirm) todos.push({ kind: "research", text: `${pendingConfirm} 个研究待确认`, link: "research" });
    if (paused) todos.push({ kind: "research", text: `${paused} 个研究暂停待续跑`, link: "research" });
    for (const b of badSources) {
      todos.push({ kind: "source", text: `「${b.name || b.url}」今日失败 ${b.fails} 次，疑似页面改版`, link: "sources" });
    }
    res.json({
      metrics: { today_total: today.n, today_ok_rate: today.n ? todayOk.n / today.n : 0, today_tokens: tokens.n },
      scenarios: { research: { pendingConfirm, paused, running },
                   custom: { active: q("SELECT COUNT(*) AS n FROM jobs WHERE type='custom' AND enabled=1").n },
                   adhoc: { today: adhoc } },
      todos,
    });
  });
}
