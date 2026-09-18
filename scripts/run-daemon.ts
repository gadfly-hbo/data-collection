/** 后台守护进程：Job 内核 tick 调度（PLAN §11）——扫描 enabled jobs 按到期执行。
 *  单 Worker 串行（SQLite 单写 + 同域限速）；SIGINT/SIGTERM 排干在途任务后退出。
 *  用法：node scripts/run-daemon.ts [--config config/settings.yaml] [--log-file data/daemon.log] */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadDotenv } from "../src/dotenv.ts";
loadDotenv();

import { BudgetGuard } from "../src/budget.ts";
import { loadSettings, type Settings } from "../src/config.ts";
import { DedupGate } from "../src/dedup.ts";
import { Fetcher } from "../src/fetcher.ts";
import { JobKernel, type JobContext } from "../src/jobs/kernel.ts";
import { CustomExecutor } from "../src/jobs/customExecutor.ts";
import { SourceExecutor } from "../src/jobs/sourceExecutor.ts";
import { Pipeline } from "../src/pipeline.ts";
import { createProviderStack } from "../src/providers/factory.ts";
import { JobStatus } from "../src/status.ts";
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

export interface DaemonContext {
  kernel: JobKernel;
  /** webapp 的对话助手 / 发现 Agent 复用其 provider */
  pipeline: Pipeline;
  fetcher: Fetcher;
  db: Database;
  notifyEnabled: boolean;
  tickS: number;
}

/** 任务执行上下文：BLOCKED / 异常 → 日志 + 可选 macOS 通知 */
export function makeJobContext(ctx: DaemonContext): JobContext {
  return {
    db: ctx.db,
    onEvent: (kind, message) => {
      if (kind === "blocked") {
        log("ERROR", `[BLOCKED] ${message}`);
        notify("采集被目标站封锁", message, ctx.notifyEnabled);
      } else {
        log("ERROR", `任务异常 ${message}`);
        notify("采集任务异常", message, ctx.notifyEnabled);
      }
    },
  };
}

export function buildContext(settings: Settings, db: Database): DaemonContext {
  const fetchCfg = settings.fetch ?? {};
  const fetcher = new Fetcher(
    fetchCfg.user_agent ?? "DataCollectorBot/0.1",
    fetchCfg.min_interval_per_host_s ?? 5,
    fetchCfg.respect_robots ?? true,
  );
  const pipeline = new Pipeline(
    fetcher,
    createProviderStack(settings.provider),
    new RawStore(resolve(REPO_ROOT, "data/raw")),
    new DedupGate(db),
    new RunLedger(db),
  );
  const budget = settings.budget
    ? new BudgetGuard(db, settings.budget.max_tasks_per_day, settings.budget.max_input_tokens_per_day)
    : null;
  const kernel = new JobKernel(
    db, { source: new SourceExecutor(pipeline), custom: new CustomExecutor(fetcher) }, budget);
  return {
    kernel,
    pipeline,
    fetcher,
    db,
    notifyEnabled: settings.alerts?.macos_notify ?? false,
    tickS: settings.scheduler?.tick_s ?? 30,
  };
}

/** tick：完全委托内核（到期判断/串行/预算都在内核），此处只挂结果日志 */
export async function runTick(ctx: DaemonContext): Promise<void> {
  await ctx.kernel.tick(makeJobContext(ctx), (job, result) => {
    if (result.status === JobStatus.SUCCESS) {
      log("INFO", `[success] job#${job.id} ${job.type} ${job.name ?? ""} tokens=(${result.inputTokens},${result.outputTokens})`.trim());
    } else if (result.status === JobStatus.SKIPPED) {
      log("WARN", `[skipped] job#${job.id} ${job.name ?? ""} ${result.error ?? ""}`.trim());
    }
    // failed/paused 的细节已由 onEvent 或执行器日志输出
  });
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

  const enabled = db.listJobs({ enabled: true });
  if (enabled.length === 0) {
    log("ERROR", "无启用的任务——先运行 scripts/import-sources.ts 迁移 sources.yaml，或在控制台添加来源");
    return 2;
  }
  log("INFO", `启用任务 ${enabled.length} 个：${enabled.map((j) => `${j.type}#${j.id}`).join(", ")}`);

  let timer: NodeJS.Timeout | null = null;
  const shutdown = async (sig: string) => {
    if (timer === null) {
      log("ERROR", `再次收到 ${sig}，强制退出（在途任务可能中断）`);
      process.exit(130);
    }
    log("INFO", `收到 ${sig}，等待在途任务排干（再次发送可强制退出）`);
    if (timer) clearInterval(timer);
    timer = null;
    await ctx.fetcher.close();
    db.close();
    log("INFO", "守护进程已退出");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await runTick(ctx); // 首 tick 立即执行
  timer = setInterval(() => {
    runTick(ctx).catch((e) => log("ERROR", `tick 执行异常：${e}`));
  }, ctx.tickS * 1000);
  log("INFO", `守护进程已启动（tick=${ctx.tickS}s，Ctrl-C 优雅退出）`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
