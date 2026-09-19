/** Web 控制台：Express JSON API + 独立 HTML 前端（路由模块在 scripts/routes/）。
 *  一键启动：node scripts/webapp.ts（自动打开浏览器）
 *  默认内置采集调度（tick 模型，单进程单写）——与 run-daemon 二选一运行。 */
import { resolve } from "node:path";

import express, { type Express } from "express";

import { loadDotenv } from "../src/dotenv.ts";
loadDotenv();

import { loadSettings } from "../src/config.ts";
import { Database } from "../src/storage/db.ts";
import { buildContext, runTick, type DaemonContext } from "./run-daemon.ts";
import { registerChatRoutes } from "./routes/chat.ts";
import { registerDataRoutes } from "./routes/data.ts";
import { registerOverviewRoutes } from "./routes/overview.ts";
import { registerResearchRoutes } from "./routes/research.ts";
import { registerSourceRoutes } from "./routes/sources.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WEB_DIR = resolve(REPO_ROOT, "web");
const DB_PATH = resolve(REPO_ROOT, "data/collector.db");

export function createApp(
  ctx: DaemonContext,
  db: Database,
  opts: { withScheduler?: boolean; discover?: (topic: string) => Promise<unknown> } = {},
): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // 前端静态资源
  app.use("/static", express.static(WEB_DIR));
  app.use(express.static(WEB_DIR));
  app.get("/", (_req, res) => res.sendFile(resolve(WEB_DIR, "index.html")));

  // 路由模块注册（按域分组）
  registerOverviewRoutes(app, db);
  registerSourceRoutes(app, db, ctx);
  registerResearchRoutes(app, db);
  registerDataRoutes(app, db);
  registerChatRoutes(app, ctx, opts);

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
