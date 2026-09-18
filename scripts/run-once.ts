/** 单次采集入口：node scripts/run-once.ts --url <url> [--schema NewsItem] [--browser]
 *  退出码：0 = SUCCESS / SKIPPED_*；1 = 任务失败；2 = 环境/配置错误。 */
import { resolve } from "node:path";

import { loadDotenv } from "../src/dotenv.ts";
loadDotenv();

import { BudgetExhausted, BudgetGuard } from "../src/budget.ts";
import { loadSettings } from "../src/config.ts";
import { DedupGate } from "../src/dedup.ts";
import { Fetcher } from "../src/fetcher.ts";
import { getSchema } from "../src/models/schemas.ts";
import { Pipeline, isOkOutcome } from "../src/pipeline.ts";
import { createProviderStack } from "../src/providers/factory.ts";
import { Database } from "../src/storage/db.ts";
import { RunLedger } from "../src/storage/ledger.ts";
import { RawStore } from "../src/storage/rawStore.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url as string | undefined;
  if (!url) {
    console.error("用法: node scripts/run-once.ts --url <url> [--schema NewsItem] [--browser]");
    return 2;
  }
  const settings = loadSettings(resolve(REPO_ROOT, (args.config as string) ?? "config/settings.yaml"));

  let provider;
  let schema;
  try {
    provider = createProviderStack(settings.provider);
    schema = getSchema((args.schema as string) ?? "NewsItem");
  } catch (e) {
    console.log(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }, null, 2));
    return 2;
  }

  const db = new Database(resolve(REPO_ROOT, "data/collector.db"));
  const budgetCfg = settings.budget;
  if (budgetCfg) {
    const budget = new BudgetGuard(db, budgetCfg.max_tasks_per_day, budgetCfg.max_input_tokens_per_day);
    try {
      budget.check();
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        console.log(JSON.stringify({ error: e.message }, null, 2));
        return 2;
      }
      throw e;
    }
  }

  const fetchCfg = settings.fetch ?? {};
  const fetcher = new Fetcher(
    fetchCfg.user_agent ?? "DataCollectorBot/0.1",
    fetchCfg.min_interval_per_host_s ?? 5,
    fetchCfg.respect_robots ?? true,
  );
  const pipeline = new Pipeline(
    fetcher,
    provider,
    new RawStore(resolve(REPO_ROOT, "data/raw")),
    new DedupGate(db),
    new RunLedger(db),
  );
  try {
    const outcome = await pipeline.run({
      url,
      schema,
      instruction: (args.instruction as string) ?? "从以下网页正文提取资讯信息",
      useBrowser: Boolean(args.browser),
    });
    console.log(JSON.stringify({
      status: outcome.status,
      run_id: outcome.runId,
      url: outcome.url,
      provider: outcome.provider,
      model: outcome.model,
      input_tokens: outcome.inputTokens,
      output_tokens: outcome.outputTokens,
      duration_ms: outcome.durationMs,
      error: outcome.error ?? null,
      item: outcome.item ?? null,
    }, null, 2));
    return isOkOutcome(outcome.status) ? 0 : 1;
  } finally {
    await fetcher.close();
    db.close();
  }
}

process.exit(await main());
