/** CustomExecutor：type=custom 任务——connector 抓取 → 增量行 → artifacts(dataset)。
 *  零 LLM 路径；跨运行按时间戳水位（wm，持久化于 job.payload._wm）去重增量。 */
import { getConnector, type DatasetRow } from "../connectors/registry.ts";
import type { Fetcher } from "../fetcher.ts";
import { JobStatus } from "../status.ts";
import type { Database } from "../storage/db.ts";
import type { JobContext, JobExecutor, JobResult, JobRow } from "./kernel.ts";

export class CustomExecutor implements JobExecutor {
  readonly type = "custom";
  private readonly fetcher: Fetcher;

  constructor(fetcher: Fetcher) {
    this.fetcher = fetcher;
  }

  async run(job: JobRow, ctx: JobContext): Promise<JobResult> {
    let payload: { connector?: string; params?: unknown; _wm?: string | null };
    try {
      payload = JSON.parse(job.payload) as typeof payload;
    } catch {
      return { status: JobStatus.FAILED, error: "payload 非法 JSON" };
    }
    if (!payload.connector) return { status: JobStatus.FAILED, error: "payload 缺 connector" };

    let connector;
    try {
      connector = getConnector(payload.connector);
    } catch (e) {
      return { status: JobStatus.FAILED, error: String(e) };
    }

    let rows: DatasetRow[];
    try {
      rows = await connector.fetchRows(payload.params, { fetcher: this.fetcher });
    } catch (e) {
      ctx.onEvent?.("error", `connector ${payload.connector} ${e}`);
      return { status: JobStatus.FAILED, error: `${e}` };
    }

    // 增量：仅保留新于水位（job.payload._wm）的行；无新行也记 run 但空批次
    const wm = payload._wm ?? null;
    const fresh = rows.filter((r) => !wm || r.ts > wm);
    const maxTs = rows.reduce((acc, r) => (r.ts > (acc ?? "") ? r.ts : acc), wm as string | null);

    const runId = ctx.db.conn
      .prepare("SELECT id FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1")
      .get(job.id) as { id: number } | undefined;
    if (runId && fresh.length > 0) {
      ctx.db.insertArtifact({
        jobRunId: runId.id,
        kind: "dataset",
        title: `${connector.name} ${connector.id}`,
        content: JSON.stringify(fresh),
        meta: JSON.stringify({ connector: connector.id, params: payload.params ?? {}, from: wm, to: maxTs }),
      });
    }
    // 水位推进（写回 job.payload）
    if (maxTs && maxTs !== wm) {
      payload._wm = maxTs;
      ctx.db.conn.prepare("UPDATE jobs SET payload = ? WHERE id = ?")
        .run(JSON.stringify(payload), job.id);
    }
    return { status: JobStatus.SUCCESS, detail: { rows: fresh.length, watermark: maxTs } };
  }
}
