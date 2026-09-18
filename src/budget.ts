/** 日预算熔断：任务数 / input tokens 双上限（UTC 日），超限当日停止派发新任务。
 *  统计口径为消耗 LLM 调用的终态（BILLABLE_STATUSES），SKIPPED_* 不计。 */
import { BILLABLE_STATUSES } from "./status.ts";
import type { Database } from "./storage/db.ts";

export class BudgetExhausted extends Error {}

export class BudgetGuard {
  private readonly db: Database;
  readonly maxTasksPerDay: number;
  readonly maxInputTokensPerDay: number;
  private readonly today: () => string;

  constructor(
    db: Database,
    maxTasksPerDay: number,
    maxInputTokensPerDay: number,
    today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {
    this.db = db;
    this.maxTasksPerDay = maxTasksPerDay;
    this.maxInputTokensPerDay = maxInputTokensPerDay;
    this.today = today;
  }

  usage(): { tasks: number; tokens: number } {
    const placeholders = BILLABLE_STATUSES.map(() => "?").join(",");
    const row = this.db.conn
      .prepare(
        `SELECT COUNT(*) AS tasks, COALESCE(SUM(input_tokens), 0) AS tokens
         FROM crawl_runs WHERE status IN (${placeholders})
         AND substr(created_at, 1, 10) = ?`,
      )
      .get(...BILLABLE_STATUSES, this.today()) as { tasks: number; tokens: number };
    return { tasks: row.tasks, tokens: row.tokens };
  }

  /** 超限抛 BudgetExhausted（消息含用量与上限）；否则返回当前用量。 */
  check(): { tasks: number; tokens: number } {
    const { tasks, tokens } = this.usage();
    if (tasks >= this.maxTasksPerDay) {
      throw new BudgetExhausted(`今日任务数已达上限：${tasks}/${this.maxTasksPerDay}，停止派发新任务`);
    }
    if (tokens >= this.maxInputTokensPerDay) {
      throw new BudgetExhausted(
        `今日 input tokens 已达上限：${tokens}/${this.maxInputTokensPerDay}，停止派发新任务`,
      );
    }
    return { tasks, tokens };
  }
}
