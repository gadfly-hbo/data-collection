/** Job 内核：统一调度实体与执行器契约（PLAN §11）。
 *  runJob 包裹生命周期（job_runs: running → 终态/tokens/断点快照）；
 *  tickJobs 扫描 enabled jobs 按调度到期执行——所有场景共用一个调度器、
 *  一个预算口径、一个任务级台账。 */
import { BudgetExhausted, BudgetGuard } from "../budget.ts";
import { JobStatus } from "../status.ts";
import type { Database } from "../storage/db.ts";

export interface JobRow {
  id: number;
  type: string;
  name: string | null;
  ref_id: number | null;
  payload: string;
  schedule: string;
  enabled: number;
}

export interface Schedule {
  kind: "interval";
  intervalS: number;
}

export function parseSchedule(raw: string): Schedule {
  const parsed = JSON.parse(raw) as { kind?: string; interval_s?: number };
  if (parsed.kind !== "interval") throw new Error(`不支持的调度类型: ${parsed.kind}`);
  return { kind: "interval", intervalS: parsed.interval_s ?? 3600 };
}

/** 执行器单次运行的结果（终态由内核写入 job_runs） */
export interface JobResult {
  status: JobStatus;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  /** research：节点状态快照（断点续跑） */
  nodeState?: string;
  /** 执行器附带的细节（如 source 任务的 RunOutcome），内核不落库、原样透传给调用方 */
  detail?: unknown;
}

export interface JobContext {
  db: Database;
  /** 当前 job_runs 行 id（内核创建 running 行后注入；执行器写 artifact/快照用） */
  jobRunId?: number;
  /** 事件回调（BLOCKED / 异常告警等，由 daemon 注入通知能力） */
  onEvent?: (kind: "blocked" | "error", message: string) => void;
}

export interface JobExecutor {
  readonly type: string;
  run(job: JobRow, ctx: JobContext): Promise<JobResult>;
}

export class JobKernel {
  /** job_id → 上次派发时刻（ms）；派发时记账，慢任务不产生周期漂移 */
  private lastRun = new Map<number, number>();
  private readonly db: Database;
  private readonly executors: Record<string, JobExecutor>;
  private readonly budget: BudgetGuard | null;
  private readonly clock: () => number;

  constructor(
    db: Database,
    executors: Record<string, JobExecutor>,
    budget: BudgetGuard | null = null,
    clock: () => number = () => Date.now(),
  ) {
    this.db = db;
    this.executors = executors;
    this.budget = budget;
    this.clock = clock;
  }

  /** 立即执行一个 job（计划确认后的手动触发也走这里）。 */
  async runJob(job: JobRow, ctx: JobContext = { db: this.db }): Promise<JobResult> {
    const executor = this.executors[job.type];
    if (!executor) {
      const runId = this.db.insertJobRun({ jobId: job.id, status: JobStatus.FAILED });
      const result: JobResult = {
        status: JobStatus.FAILED,
        error: `无 ${job.type} 类型的执行器`,
      };
      this.db.updateJobRun(runId, result);
      return result;
    }
    if (this.budget) {
      try {
        this.budget.check();
      } catch (e) {
        if (e instanceof BudgetExhausted) {
          const runId = this.db.insertJobRun({ jobId: job.id, status: JobStatus.SKIPPED });
          const result: JobResult = { status: JobStatus.SKIPPED, error: e.message };
          this.db.updateJobRun(runId, result);
          return result;
        }
        throw e;
      }
    }
    const runId = this.db.insertJobRun({ jobId: job.id, status: JobStatus.RUNNING });
    const runCtx: JobContext = { ...ctx, jobRunId: runId };
    try {
      const result = await executor.run(job, runCtx);
      this.db.updateJobRun(runId, result);
      return result;
    } catch (e) {
      // 执行器未捕获的异常也必须有任务级终态（台账规则）
      const result: JobResult = {
        status: JobStatus.FAILED,
        error: `${e instanceof Error ? e.name : "Error"}: ${e}`,
      };
      this.db.updateJobRun(runId, result);
      return result;
    }
  }

  /** 扫描 enabled jobs：到期（now ≥ lastRun + 当前 interval_s）各执行一次。
   *  到期按当次扫描的 schedule 现算——改间隔下个 tick 生效；串行执行。
   *  onResult：每个到期任务执行完后的回调（daemon 日志用），不影响调度。 */
  async tick(
    ctx: JobContext = { db: this.db },
    onResult?: (job: JobRow, result: JobResult) => void,
  ): Promise<void> {
    const now = this.clock();
    for (const raw of this.db.listJobs({ enabled: true })) {
      const job = raw as unknown as JobRow;
      const schedule = parseSchedule(job.schedule);
      const last = this.lastRun.get(job.id);
      if (last !== undefined && now < last + schedule.intervalS * 1000) continue;
      this.lastRun.set(job.id, this.clock());
      const result = await this.runJob(job, ctx);
      onResult?.(job, result);
    }
  }
}
