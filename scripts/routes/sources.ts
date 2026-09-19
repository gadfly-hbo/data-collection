/** 来源 CRUD + 连接器市场 + 定制任务 + 立即采集 */
import type { Express } from "express";
import { getSchema } from "../../src/models/schemas.ts";
import { SCHEMA_REGISTRY } from "../../src/models/schemas.ts";
import { isOkOutcome, type RunOutcome } from "../../src/pipeline.ts";
import { JobStatus } from "../../src/status.ts";
import { CONNECTOR_REGISTRY, getConnector } from "../../src/connectors/registry.ts";
import { Database, retryOnBusy } from "../../src/storage/db.ts";
import * as queries from "../../src/storage/queries.ts";
import { makeJobContext, type DaemonContext } from "../run-daemon.ts";
import { outcomeToApi } from "./helpers.ts";

export function registerSourceRoutes(app: Express, db: Database, ctx: DaemonContext): void {
  app.get("/api/sources", (_req, res) => res.json(queries.listSourcesWithLastRun(db)));

  app.post("/api/sources", (req, res) => {
    try {
      const body = req.body ?? {};
      const id = retryOnBusy(() => db.upsertSource({
        url: body.url, schemaType: body.schema_type, name: body.name ?? null,
        intervalS: Number(body.interval_s ?? 3600), enabled: body.enabled ?? true,
        useBrowser: Boolean(body.use_browser), instruction: body.instruction ?? "",
      }));
      res.json({ ok: true, id });
    } catch (e) {
      res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete("/api/sources/:id", (req, res) => {
    try {
      const deleted = retryOnBusy(() => db.deleteSource(Number(req.params.id)));
      if (!deleted) return res.status(404).json({ detail: "来源不存在" });
      res.json({ ok: true });
    } catch {
      res.status(409).json({ detail: "该来源存在关联台账，不可删除；请改用「停用」" });
    }
  });

  app.get("/api/connectors", (_req, res) => {
    res.json(Object.values(CONNECTOR_REGISTRY).map((c) => {
      const shape = (c.params as unknown as { _def?: { shape?: () => Record<string, { description?: string; options?: { values?: unknown[] } }> } })._def?.shape?.() ?? {};
      return {
        id: c.id, name: c.name, description: c.description, min_interval_s: c.minIntervalS,
        api: !!c.api,
        params: Object.fromEntries(Object.entries(shape).map(([k, v]) => {
          const def = (v as { _def?: { values?: string[]; description?: string } })._def ?? {};
          return [k, { description: def.description ?? v.description ?? "", options: def.values ?? null }];
        })),
      };
    }));
  });

  app.post("/api/jobs", (req, res) => {
    const body = req.body ?? {};
    let connector;
    try {
      connector = getConnector(String(body.connector ?? ""));
      connector.params.parse(body.params ?? {});
    } catch (e) {
      return res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
    }
    const intervalS = Number(body.interval_s ?? connector.minIntervalS);
    if (intervalS < connector.minIntervalS) {
      return res.status(400).json({ detail: `${connector.name} 最小间隔 ${connector.minIntervalS}s` });
    }
    const jobId = retryOnBusy(() => db.insertJob({
      type: "custom", name: body.name ?? connector.name,
      payload: JSON.stringify({ connector: connector.id, params: body.params ?? {}, _wm: null }),
      schedule: JSON.stringify({ kind: "interval", interval_s: intervalS }),
    }));
    res.json({ ok: true, id: jobId });
  });

  app.get("/api/jobs", (req, res) => {
    const type = (req.query.type as string) || "custom";
    res.json(db.conn.prepare(
      `SELECT j.*,
         (SELECT r.status FROM job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_status,
         (SELECT r.error FROM job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_error,
         (SELECT r.finished_at FROM job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_run_at
       FROM jobs j WHERE j.type = ? ORDER BY j.id`).all(type));
  });

  app.delete("/api/jobs/:id", (req, res) => {
    if (!db.getJob(Number(req.params.id))) return res.status(404).json({ detail: "任务不存在" });
    retryOnBusy(() => db.setJobEnabled(Number(req.params.id), false));
    res.json({ ok: true });
  });

  app.post("/api/run", async (req, res) => {
    const body = req.body ?? {};
    if (body.source_id != null) {
      const job = db.getSourceJob(Number(body.source_id));
      if (!job) return res.status(404).json({ detail: "来源不存在" });
      const result = await ctx.kernel.runJob(job as never, makeJobContext(ctx));
      if (result.status === JobStatus.SKIPPED) {
        return res.json({ ok: false, error: `任务被预算熔断跳过：${result.error ?? ""}` });
      }
      const outcome = result.detail as RunOutcome | undefined;
      if (outcome) return res.json({ ok: isOkOutcome(outcome.status), ...outcomeToApi(outcome) });
      return res.json({ ok: false, status: "FETCH_ERROR", error: result.error });
    }
    if (!body.url) return res.status(422).json({ detail: "需要 source_id 或 url" });
    if (!SCHEMA_REGISTRY[body.schema_type ?? "NewsItem"]) {
      return res.status(400).json({ detail: `未知 schema_type: ${body.schema_type}` });
    }
    const outcome = await ctx.pipeline.run({
      url: String(body.url), schema: getSchema(body.schema_type ?? "NewsItem"),
      instruction: body.instruction ?? "", useBrowser: Boolean(body.use_browser),
    });
    res.json({ ok: isOkOutcome(outcome.status), ...outcomeToApi(outcome) });
  });
}
