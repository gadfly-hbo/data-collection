/** SourceExecutor：type=source 任务的执行器——包装现有 pipeline（行为不变迁移）。
 *  crawl_runs（动作级台账）照旧由 pipeline.ledger 写入；此处只做
 *  RunStatus → JobStatus 的任务级映射与告警回调。 */
import { getSchema } from "../models/schemas.ts";
import { isOkOutcome, type Pipeline, type RunOutcome } from "../pipeline.ts";
import { RunStatus } from "../status.ts";
import type { Database } from "../storage/db.ts";
import type { JobContext, JobExecutor, JobResult, JobRow } from "./kernel.ts";
import { JobStatus } from "../status.ts";

interface SourceRow {
  id: number;
  url: string;
  schema_type: string;
  use_browser: number;
  instruction: string;
}

export class SourceExecutor implements JobExecutor {
  readonly type = "source";
  private readonly pipeline: Pipeline;

  constructor(pipeline: Pipeline) {
    this.pipeline = pipeline;
  }

  async run(job: JobRow, ctx: JobContext): Promise<JobResult> {
    if (job.ref_id == null) {
      return { status: JobStatus.FAILED, error: "source 任务缺 ref_id" };
    }
    const row = ctx.db.conn.prepare("SELECT * FROM sources WHERE id = ?").get(job.ref_id) as
      | SourceRow
      | undefined;
    if (!row) {
      return { status: JobStatus.FAILED, error: `sources#${job.ref_id} 不存在` };
    }

    let outcome: RunOutcome;
    try {
      outcome = await this.pipeline.run({
        url: row.url,
        schema: getSchema(row.schema_type),
        instruction: row.instruction || "",
        sourceId: row.id,
        useBrowser: Boolean(row.use_browser),
      });
    } catch (e) {
      // 硬性规则：pipeline 之外的异常（如非法 schema_type）也必须写 crawl_runs
      const failed: RunOutcome = {
        status: RunStatus.FETCH_ERROR, url: row.url,
        inputTokens: 0, outputTokens: 0, provider: "", model: "", durationMs: 0,
        error: `${e instanceof Error ? e.name : "Error"}: ${e}`,
      };
      this.pipeline.ledger?.record(failed, String(row.schema_type), row.id);
      ctx.onEvent?.("error", `${row.url} ${e}`);
      return {
        status: JobStatus.FAILED,
        error: failed.error,
      };
    }

    if (outcome.status === RunStatus.BLOCKED) {
      ctx.onEvent?.("blocked", `${row.url} ${outcome.error ?? ""}`.trim());
    } else if (!isOkOutcome(outcome.status)) {
      ctx.onEvent?.("error", `${row.url} ${outcome.error ?? ""}`.trim());
    }
    return {
      status: isOkOutcome(outcome.status) ? JobStatus.SUCCESS : JobStatus.FAILED,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      error: outcome.error,
      detail: outcome, // webapp 手动执行路径需要 RunOutcome 细节（item/status/run_id）
    };
  }
}
