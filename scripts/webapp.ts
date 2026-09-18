/** Web 控制台：独立 HTML 前端 + Express JSON API。
 *  一键启动：node scripts/webapp.ts（自动打开浏览器）
 *  默认内置采集调度（tick 模型，单进程单写）——与 run-daemon 二选一运行。 */
import { resolve } from "node:path";

import express, { type Express } from "express";

import { loadDotenv } from "../src/dotenv.ts";
loadDotenv();

import { BudgetExhausted } from "../src/budget.ts";
import { loadSettings, type Settings } from "../src/config.ts";
import { isOkOutcome } from "../src/pipeline.ts";
import { SCHEMA_REGISTRY } from "../src/models/schemas.ts";
import { planWithUser } from "../src/planner.ts";
import { TransientProviderError } from "../src/providers/base.ts";
import { Database } from "../src/storage/db.ts";
import * as queries from "../src/storage/queries.ts";
import { fetchRows, toCsv, toJson, toMarkdown } from "./export-data.ts";
import {
  buildContext,
  enabledSources,
  runSource,
  runTick,
  type DaemonContext,
} from "./run-daemon.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WEB_DIR = resolve(REPO_ROOT, "web");
const DB_PATH = resolve(REPO_ROOT, "data/collector.db");

function zodDescription(schema: unknown): string {
  return ((schema as { description?: string }).description ?? "").trim();
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
      const id = db.upsertSource({
        url: body.url,
        schemaType: body.schema_type,
        name: body.name ?? null,
        intervalS: Number(body.interval_s ?? 3600),
        enabled: body.enabled ?? true,
        useBrowser: Boolean(body.use_browser),
        instruction: body.instruction ?? "",
      });
      res.json({ ok: true, id });
    } catch (e) {
      res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete("/api/sources/:id", (req, res) => {
    try {
      const deleted = db.deleteSource(Number(req.params.id));
      if (!deleted) return res.status(404).json({ detail: "来源不存在" });
      res.json({ ok: true });
    } catch {
      res.status(409).json({ detail: "该来源存在关联台账，不可删除；请改用「停用」" });
    }
  });

  app.post("/api/run", async (req, res) => {
    const body = req.body ?? {};
    let source: Record<string, unknown>;
    if (body.source_id != null) {
      const row = db.conn.prepare("SELECT * FROM sources WHERE id = ?").get(body.source_id);
      if (!row) return res.status(404).json({ detail: "来源不存在" });
      source = row as Record<string, unknown>;
    } else {
      if (!body.url) return res.status(422).json({ detail: "需要 source_id 或 url" });
      if (!SCHEMA_REGISTRY[body.schema_type ?? "NewsItem"]) {
        return res.status(400).json({ detail: `未知 schema_type: ${body.schema_type}` });
      }
      source = {
        id: null,
        url: body.url,
        schema_type: body.schema_type ?? "NewsItem",
        use_browser: body.use_browser ? 1 : 0,
        instruction: body.instruction ?? "",
      };
    }
    try {
      const outcome = await runSource(source as never, ctx);
      if (!outcome) {
        return res.json({ ok: false,
          error: "任务被预算熔断跳过（未消耗 LLM 调用，详见日志；台账不记跳过属设计口径）" });
      }
      res.json({ ok: isOkOutcome(outcome.status), ...outcome });
    } catch (e) {
      if (e instanceof BudgetExhausted) return res.status(409).json({ detail: e.message });
      throw e;
    }
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
      res.json({ reply: reply.reply, plan: reply.plan });
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
      runTick(ctx, db).catch((e) => console.error("tick 执行异常：", e));
    }, ctx.tickS * 1000);
    timer.unref();
    void runTick(ctx, db); // 首 tick 立即执行
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
