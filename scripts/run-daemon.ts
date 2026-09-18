/** 后台守护进程：周期 tick 扫描 sources 表，按 interval_s 调度采集。
 *  单 Worker 串行（SQLite 单写 + 同域限速）；SIGINT/SIGTERM 排干在途任务后退出。
 *  用法：node scripts/run-daemon.ts [--config config/settings.yaml] [--log-file data/daemon.log] */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadDotenv } from "../src/dotenv.ts";
loadDotenv();

import { BudgetExhausted, BudgetGuard } from "../src/budget.ts";
import { loadSettings, type Settings } from "../src/config.ts";
import { DedupGate } from "../src/dedup.ts";
import { Fetcher } from "../src/fetcher.ts";
import { getSchema } from "../src/models/schemas.ts";
import { Pipeline, isOkOutcome, type RunOutcome } from "../src/pipeline.ts";
import { createProviderStack } from "../src/providers/factory.ts";
import { RunStatus } from "../src/status.ts";
import { Database } from "../src/storage/db.ts";
import { RunLedger } from "../src/storage/ledger.ts";
import { RawStore } from "../src/storage/rawStore.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const logFile = process.argv.includes("--log-file")
  ? resolve(REPO_ROOT, process.argv[process.argv.indexOf("--log-file") + 1])
  : null;
if (logFile) mkdirSync(dirname(logFile), { recursive: true });

function log(level: string, msg: string): void {
  const line = `${new Date().toISOString()} ${level} daemon ${msg}`;
  if (logFile) appendFileSync(logFile, line + "\n");
  else console.log(line);
}

export interface DaemonContext {
  pipeline: Pipeline;
  fetcher: Fetcher;
  budget: BudgetGuard | null;
  /** 串行 Worker：同一时刻只跑一个来源（SQLite 单写 + 同域限速） */
  busy: Promise<void>;
  lastRun: Map<string, number>;
  tickS: number;
  notifyEnabled: boolean;
  clock: () => number;
}

function notify(title: string, message: string, enabled: boolean): void {
  if (!enabled) return;
  try {
    spawn("osascript", [
      "-e",
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
    ], { stdio: "ignore" });
  } catch (e) {
    log("WARN", `通知发送失败：${e}`);
  }
}

interface SourceRow {
  id: number;
  url: string;
  schema_type: string;
  interval_s: number;
  enabled: number;
  use_browser: number;
  instruction: string;
}

export function enabledSources(db: Database): SourceRow[] {
  return db.conn
    .prepare("SELECT * FROM sources WHERE enabled = 1 ORDER BY id")
    .all() as unknown as SourceRow[];
}

export async function runSource(source: SourceRow, ctx: DaemonContext): Promise<RunOutcome | null> {
  const job = async (): Promise<RunOutcome | null> => {
    if (ctx.budget) {
      try {
        ctx.budget.check();
      } catch (e) {
        if (e instanceof BudgetExhausted) {
          log("WARN", `预算熔断，跳过本次调度 ${source.url}：${e.message}`);
          return null;
        }
        throw e;
      }
    }
    let outcome: RunOutcome;
    try {
      outcome = await ctx.pipeline.run({
        url: source.url,
        schema: getSchema(source.schema_type),
        instruction: source.instruction || "",
        sourceId: source.id,
        useBrowser: Boolean(source.use_browser),
      });
    } catch (e) {
      log("ERROR", `任务异常 ${source.url}：${e instanceof Error ? e.name : "Error"}: ${e}`);
      notify("采集任务异常", `${source.url}\n${e}`, ctx.notifyEnabled);
      return null;
    }
    if (outcome.status === RunStatus.BLOCKED) {
      log("ERROR", `[BLOCKED] ${source.url}：${outcome.error}`);
      notify("采集被目标站封锁", `${source.url}\n${outcome.error}`, ctx.notifyEnabled);
    } else if (isOkOutcome(outcome.status)) {
      log("INFO",
        `[${outcome.status}] ${source.url} tokens=(${outcome.inputTokens},${outcome.outputTokens}) ${outcome.durationMs}ms run_id=${outcome.runId}`);
    } else {
      log("WARN", `[${outcome.status}] ${source.url} error=${outcome.error}`);
    }
    return outcome;
  };
  // 串行 Worker：挂到 busy 链尾
  const result = ctx.busy.then(job, job);
  ctx.busy = result.then(() => undefined, () => undefined);
  return result;
}

/** 扫描 sources 表：到期的启用来源各执行一次。
 *  lastRun 记派发时刻；到期按当次扫描的 interval_s 现算——改间隔下个 tick 生效。 */
export async function runTick(ctx: DaemonContext, db: Database): Promise<void> {
  const now = ctx.clock();
  for (const src of enabledSources(db)) {
    const last = ctx.lastRun.get(src.url);
    if (last !== undefined && now < last + src.interval_s * 1000) continue;
    ctx.lastRun.set(src.url, ctx.clock());
    await runSource(src, ctx);
  }
}

export function buildContext(settings: Settings, db: Database): DaemonContext {
  const fetchCfg = settings.fetch ?? {};
  const fetcher = new Fetcher(
    fetchCfg.user_agent ?? "DataCollectorBot/0.1",
    fetchCfg.min_interval_per_host_s ?? 5,
    fetchCfg.respect_robots ?? true,
  );
  const budget = settings.budget
    ? new BudgetGuard(db, settings.budget.max_tasks_per_day, settings.budget.max_input_tokens_per_day)
    : null;
  const pipeline = new Pipeline(
    fetcher,
    createProviderStack(settings.provider),
    new RawStore(resolve(REPO_ROOT, "data/raw")),
    new DedupGate(db),
    new RunLedger(db),
  );
  return {
    pipeline,
    fetcher,
    budget,
    busy: Promise.resolve(),
    lastRun: new Map(),
    tickS: settings.scheduler?.tick_s ?? 30,
    notifyEnabled: settings.alerts?.macos_notify ?? false,
    clock: () => Date.now(),
  };
}

async function main(): Promise<number> {
  const configPath = process.argv.includes("--config")
    ? resolve(REPO_ROOT, process.argv[process.argv.indexOf("--config") + 1])
    : resolve(REPO_ROOT, "config/settings.yaml");
  let settings: Settings;
  let db: Database;
  try {
    settings = loadSettings(configPath);
    db = new Database(resolve(REPO_ROOT, "data/collector.db"));
  } catch (e) {
    log("ERROR", `配置错误：${e instanceof Error ? e.message : e}`);
    return 2;
  }
  const ctx = buildContext(settings, db);

  const sources = enabledSources(db);
  if (sources.length === 0) {
    log("ERROR", "sources 表无启用来源——先运行 scripts/import-sources.ts 迁移 sources.yaml");
    return 2;
  }
  log("INFO", `启用来源 ${sources.length} 个：${sources.map((s) => s.url).join(", ")}`);

  let timer: NodeJS.Timeout | null = null;
  const shutdown = async (sig: string) => {
    if (timer === null) {
      log("ERROR", `再次收到 ${sig}，强制退出（在途任务可能中断）`);
      process.exit(130);
    }
    log("INFO", `收到 ${sig}，等待在途任务排干（再次发送可强制退出）`);
    if (timer) clearInterval(timer);
    timer = null;
    await ctx.busy;
    await ctx.fetcher.close();
    db.close();
    log("INFO", "守护进程已退出");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await runTick(ctx, db); // 首 tick 立即执行
  timer = setInterval(() => {
    runTick(ctx, db).catch((e) => log("ERROR", `tick 执行异常：${e}`));
  }, ctx.tickS * 1000);
  log("INFO", `守护进程已启动（tick=${ctx.tickS}s，Ctrl-C 优雅退出）`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
