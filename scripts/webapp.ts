/** Web 控制台：独立 HTML 前端 + Express JSON API。
 *  一键启动：node scripts/webapp.ts（自动打开浏览器）
 *  默认内置采集调度（tick 模型，单进程单写）——与 run-daemon 二选一运行。 */
import { resolve } from "node:path";

import express, { type Express } from "express";

import { loadDotenv } from "../src/dotenv.ts";
loadDotenv();

import { loadSettings, type Settings } from "../src/config.ts";
import { getSchema } from "../src/models/schemas.ts";
import { isOkOutcome, type RunOutcome } from "../src/pipeline.ts";
import { JobStatus } from "../src/status.ts";
import { SCHEMA_REGISTRY } from "../src/models/schemas.ts";
import { CONNECTOR_REGISTRY, getConnector } from "../src/connectors/registry.ts";
import { listTemplates, RESEARCH_TEMPLATES } from "../src/research/templates/index.ts";
import { parseEvidence } from "../src/research/evidence.ts";

import { planWithUser } from "../src/planner.ts";
import { TransientProviderError } from "../src/providers/base.ts";
import { Database, retryOnBusy } from "../src/storage/db.ts";
import * as queries from "../src/storage/queries.ts";
import { fetchRows, toCsv, toJson, toMarkdown } from "./export-data.ts";
import {
  buildContext,
  makeJobContext,
  runTick,
  type DaemonContext,
} from "./run-daemon.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WEB_DIR = resolve(REPO_ROOT, "web");
const DB_PATH = resolve(REPO_ROOT, "data/collector.db");

function zodDescription(schema: unknown): string {
  return ((schema as { description?: string }).description ?? "").trim();
}

export /** RunOutcome → 前端 API 契约（snake_case；Phase 6 TS 移植时曾丢失此映射） */
function outcomeToApi(outcome: RunOutcome): Record<string, unknown> {
  return {
    status: outcome.status,
    url: outcome.url,
    provider: outcome.provider,
    model: outcome.model,
    input_tokens: outcome.inputTokens,
    output_tokens: outcome.outputTokens,
    duration_ms: outcome.durationMs,
    error: outcome.error ?? null,
    run_id: outcome.runId ?? null,
    item: outcome.item ?? null,
  };
}

export function createApp(
  ctx: DaemonContext,
  db: Database,
  opts: { withScheduler?: boolean; discover?: (topic: string) => Promise<unknown> } = {},
): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // 前端静态资源
  app.use(express.static(WEB_DIR));
  app.get("/", (_req, res) => res.sendFile(resolve(WEB_DIR, "index.html")));

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
    res.json({
      summary: queries.statusSummary(db),
      daily: queries.dailyTokens(db, 14),
      blocked: queries.blockedSources(db, 10),
    });
  });

  app.get("/api/runs", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    res.json(queries.recentRuns(db, limit));
  });

  app.get("/api/sources", (_req, res) => {
    res.json(queries.listSourcesWithLastRun(db));
  });

  app.post("/api/sources", (req, res) => {
    try {
      const body = req.body ?? {};
      const id = retryOnBusy(() => db.upsertSource({
        url: body.url,
        schemaType: body.schema_type,
        name: body.name ?? null,
        intervalS: Number(body.interval_s ?? 3600),
        enabled: body.enabled ?? true,
        useBrowser: Boolean(body.use_browser),
        instruction: body.instruction ?? "",
      }));
      res.json({ ok: true, id });
    } catch (e) {
      res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- 研究任务（Phase 9）：创建=待确认（不启用），确认/续跑才进调度执行 ----
  app.get("/api/research/templates", (_req, res) => res.json(listTemplates()));

  app.post("/api/research", (req, res) => {
    const body = req.body ?? {};
    if (!RESEARCH_TEMPLATES[String(body.template ?? "")]) {
      return res.status(400).json({ detail: `未知研究模板: ${body.template}` });
    }
    const topic = String(body.topic ?? "").trim();
    if (topic.length < 2) return res.status(400).json({ detail: "研究对象过短" });
    const jobId = retryOnBusy(() => db.insertJob({
      type: "research", name: `${RESEARCH_TEMPLATES[String(body.template)].name}：${topic}`,
      payload: JSON.stringify({ template: body.template, topic,
                                maxInputTokens: body.max_input_tokens ?? undefined }),
      schedule: JSON.stringify({ kind: "interval", interval_s: 86400 }),
      enabled: false, // 计划确认前不进调度（执行确认边界）
    }));
    res.json({ ok: true, id: jobId, status: "pending_confirmation" });
  });

  app.get("/api/research/jobs", (_req, res) => {
    res.json(db.conn.prepare(
      `SELECT j.*,
         (SELECT r.status FROM job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_status,
         (SELECT r.error FROM job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_error,
         (SELECT r.node_state FROM job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_state
       FROM jobs j WHERE j.type = 'research' ORDER BY j.id`).all());
  });

  app.get("/api/research/jobs/:id", (req, res) => {
    const job = db.getJob(Number(req.params.id));
    if (!job || job.type !== "research") return res.status(404).json({ detail: "研究任务不存在" });
    const run = db.conn.prepare(
      "SELECT id, status, node_state, input_tokens, output_tokens, error, finished_at FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1")
      .get(Number(job.id)) as Record<string, unknown> | undefined;
    const report = db.conn.prepare(
      `SELECT a.id, a.content, a.meta FROM artifacts a JOIN job_runs r ON a.job_run_id = r.id
       WHERE r.job_id = ? AND a.kind = 'report' ORDER BY a.id DESC LIMIT 1`)
      .get(Number(job.id)) as { id: number; content: string; meta: string | null } | undefined;
    let evidence: unknown[] = [];
    if (report) {
      try {
        evidence = (JSON.parse(String(report.meta ?? "{}")).evidence as unknown[]) ?? [];
      } catch { /* meta 缺字段 */ }
      if (!evidence.length) evidence = parseEvidence(report.content);
    }
    let nodeTitles: Record<string, string> = {};
    try {
      const tpl = RESEARCH_TEMPLATES[String(JSON.parse(String(job.payload)).template)];
      if (tpl) nodeTitles = Object.fromEntries(tpl.nodes.map((n) => [n.id, n.title]));
    } catch { /* 忽略 */ }
    let nodes: Record<string, { status: string }> = {};
    let progress = { done: 0, total: 0 };
    if (run?.node_state) {
      try {
        nodes = Object.fromEntries(Object.entries(
          (JSON.parse(String(run.node_state)) as { nodes: Record<string, { status: string }> }).nodes)
          .map(([k, v]) => [k, { status: v.status }]));
        progress = { done: Object.values(nodes).filter((n) => n.status === "done").length,
                     total: Object.keys(nodes).length };
      } catch { /* 快照损坏时降级为空进度 */ }
    }
    res.json({ job, run: run ?? null, nodes, nodeTitles, progress, evidence, report: report?.content ?? null, artifactId: report?.id ?? null });
  });

  const researchActivate = (id: number, res: import("express").Response) => {
    const job = db.getJob(id);
    if (!job || job.type !== "research") return res.status(404).json({ detail: "研究任务不存在" });
    db.setJobEnabled(id, true);
    res.json({ ok: true, running: true });
    return undefined;
  };
  app.post("/api/research/jobs/:id/confirm", (req, res) => researchActivate(Number(req.params.id), res));
  app.post("/api/research/jobs/:id/resume", (req, res) => researchActivate(Number(req.params.id), res));

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
    const rows = db.conn
      .prepare(
        `SELECT j.*,
           (SELECT r.status FROM job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_status,
           (SELECT r.error FROM job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_error,
           (SELECT r.finished_at FROM job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_run_at
         FROM jobs j WHERE j.type = ? ORDER BY j.id`)
      .all(type);
    res.json(rows);
  });

  app.get("/api/export/report/:artifactId", (req, res) => {
    const art = db.conn.prepare("SELECT title, content FROM artifacts WHERE id = ? AND kind = 'report'")
      .get(Number(req.params.artifactId)) as { title: string | null; content: string } | undefined;
    if (!art) return res.status(404).json({ detail: "报告不存在" });
    res.setHeader("Content-Disposition", 'attachment; filename="report.md"');
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(`# ${art.title ?? "研究报告"}\n\n${art.content}`);
  });

  app.get("/api/dataset/:jobId", (req, res) => {
    const job = db.getJob(Number(req.params.jobId));
    if (!job) return res.status(404).json({ detail: "任务不存在" });
    const latest = db.conn
      .prepare("SELECT id, title, content, meta, created_at FROM artifacts WHERE kind = 'dataset' AND job_run_id IN (SELECT id FROM job_runs WHERE job_id = ?) ORDER BY id DESC LIMIT 1")
      .get(Number(job.id)) as Record<string, unknown> | undefined;
    if (!latest) return res.json({ rows: [], meta: null });
    res.json({
      rows: JSON.parse(String(latest.content)),
      meta: JSON.parse(String(latest.meta ?? "null")),
      created_at: latest.created_at,
    });
  });

  app.delete("/api/jobs/:id", (req, res) => {
    if (!db.getJob(Number(req.params.id))) return res.status(404).json({ detail: "任务不存在" });
    retryOnBusy(() => db.setJobEnabled(Number(req.params.id), false));
    res.json({ ok: true });
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

  app.post("/api/run", async (req, res) => {
    const body = req.body ?? {};
    if (body.source_id != null) {
      // 来源任务：走 Job 内核（job_runs 任务级台账 + crawl_runs 动作级台账）
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
    // ad-hoc 单页采集：非任务实体，直接走 pipeline（仅 crawl_runs 动作级台账）
    if (!body.url) return res.status(422).json({ detail: "需要 source_id 或 url" });
    if (!SCHEMA_REGISTRY[body.schema_type ?? "NewsItem"]) {
      return res.status(400).json({ detail: `未知 schema_type: ${body.schema_type}` });
    }
    const outcome = await ctx.pipeline.run({
      url: String(body.url),
      schema: getSchema(body.schema_type ?? "NewsItem"),
      instruction: body.instruction ?? "",
      useBrowser: Boolean(body.use_browser),
    });
    res.json({ ok: isOkOutcome(outcome.status), ...outcomeToApi(outcome) });
  });

  app.get("/api/items", (req, res) => {
    const { rows, total } = queries.queryItems(db, {
      schemaType: (req.query.schema_type as string) || undefined,
      keyword: (req.query.keyword as string) || undefined,
      limit: Math.min(Number(req.query.limit ?? 100), 500),
    });
    res.json({ total, items: rows });
  });

  app.get("/api/export", (req, res) => {
    const format = (req.query.format as string) ?? "json";
    const renderers: Record<string, (r: ReturnType<typeof fetchRows>) => string> = {
      csv: toCsv,
      json: toJson,
      markdown: toMarkdown,
    };
    const render = renderers[format];
    if (!render) return res.status(400).json({ detail: `未知格式: ${format}` });
    const rows = fetchRows(db, {
      schemaType: req.query.schema_type as string | undefined,
      since: req.query.since as string | undefined,
      until: req.query.until as string | undefined,
    });
    const ext = ({ csv: "csv", json: "json", markdown: "md" } as Record<string, string>)[format];
    const media = ({
      csv: "text/csv; charset=utf-8",
      json: "application/json; charset=utf-8",
      markdown: "text/markdown; charset=utf-8",
    } as Record<string, string>)[format];
    res.setHeader("Content-Disposition", `attachment; filename="collector.${ext}"`);
    res.type(media).send(render(rows));
  });

  app.post("/api/chat", async (req, res) => {
    const history = (req.body?.history ?? []) as { role?: string; content?: string }[];
    if (
      !history.length ||
      !history.every((h) => (h.role === "user" || h.role === "assistant") && h.content)
    ) {
      return res.status(422).json({ detail: "对话历史格式不正确" });
    }
    try {
      const reply = await planWithUser(
        ctx.pipeline.provider,
        history as { role: "user" | "assistant"; content: string }[],
        Object.keys(SCHEMA_REGISTRY).sort(),
      );
      if (reply.plan && !SCHEMA_REGISTRY[reply.plan.schema_type]) {
        reply.plan.schema_type = Object.keys(SCHEMA_REGISTRY).sort()[0]; // 兜底到首个注册类型
      }
      res.json({ reply: reply.reply, plan: reply.plan,
                 intent: reply.intent ?? "collect", research: reply.research });
    } catch (e) {
      if (e instanceof TransientProviderError) {
        return res.status(503).json({ detail: "LLM 供应商暂时不可用（配额或限流），请稍后重试" });
      }
      throw e;
    }
  });

  // 来源发现（T6.7：pi SDK 嵌入的 Agent + MiniMax web_search）
  app.post("/api/discover", async (req, res) => {
    if (!opts.discover) {
      return res.status(501).json({ detail: "发现功能未启用（SDK 注入缺失）" });
    }
    const topic = (req.body?.topic ?? "").trim();
    if (!topic) return res.status(422).json({ detail: "需要 topic" });
    try {
      res.json({ ok: true, candidates: await opts.discover(topic) });
    } catch (e) {
      res.status(503).json({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  if (opts.withScheduler) {
    const timer = setInterval(() => {
      runTick(ctx).catch((e) => console.error("tick 执行异常：", e));
    }, ctx.tickS * 1000);
    timer.unref();
    void runTick(ctx); // 首 tick 立即执行
    app.locals.tickTimer = timer;
  }
  return app;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf("--port") + 1] || 8500);
  const noBrowser = args.includes("--no-browser");
  const noScheduler = args.includes("--no-scheduler");

  const settings = loadSettings(resolve(REPO_ROOT, "config/settings.yaml"));
  const db = new Database(DB_PATH);
  const ctx = buildContext(settings, db);

  // 来源发现（pi SDK 嵌入）：配额/依赖不可用时优雅降级为 501
  let discover: ((topic: string) => Promise<unknown>) | undefined;
  try {
    const { discoverSources } = await import("../src/discovery/agent.ts");
    discover = (topic) => discoverSources(topic, db);
  } catch (e) {
    console.warn("发现 Agent 不可用：", e instanceof Error ? e.message : e);
  }

  const app = createApp(ctx, db, { withScheduler: !noScheduler, discover });
  const url = `http://127.0.0.1:${port}`;
  app.listen(port, "127.0.0.1", () => {
    console.log(`\n  采集控制台已启动：${url} （Ctrl-C 退出）\n  定时调度：${noScheduler ? "关" : "开"}｜与 run-daemon 请二选一运行\n`);
    if (!noBrowser) {
      import("node:child_process").then(({ spawn }) =>
        spawn("open", [url], { stdio: "ignore" }).unref());
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
