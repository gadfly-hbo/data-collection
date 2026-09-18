/** ResearchExecutor：type=research——工作流引擎 + pi SDK 节点执行器。
 *  快照续跑：取本任务最近一次含 node_state 的 job_runs 作起点；执行结果写入
 *  内核创建的当前 running 行。完成→artifacts(kind=report)；暂停→paused+快照。 */
import { z } from "zod";

import { JobStatus } from "../status.ts";
import { initialState, validateTemplate, WorkflowEngine, type NodeRunner, type WorkflowState } from "../research/engine.ts";
import { RESEARCH_TEMPLATES } from "../research/templates/index.ts";
import type { Database } from "../storage/db.ts";
import type { JobContext, JobExecutor, JobResult, JobRow } from "./kernel.ts";

const ResearchPayload = z.object({
  template: z.string(),
  topic: z.string(),
  maxInputTokens: z.number().int().positive().optional(),
});

export class ResearchExecutor implements JobExecutor {
  readonly type = "research";
  private readonly makeRunner: () => NodeRunner;

  constructor(makeRunner: () => NodeRunner) {
    this.makeRunner = makeRunner;
  }

  async run(job: JobRow, ctx: JobContext): Promise<JobResult> {
    let payload;
    try {
      payload = ResearchPayload.parse(JSON.parse(job.payload));
    } catch (e) {
      return { status: JobStatus.FAILED, error: `payload 非法：${e}` };
    }
    const template = RESEARCH_TEMPLATES[payload.template];
    if (!template) {
      return { status: JobStatus.FAILED, error: `未知模板 ${payload.template}` };
    }
    try {
      validateTemplate(template);
    } catch (e) {
      return { status: JobStatus.FAILED, error: String(e) };
    }

    // 续跑起点：最近一次带快照的 job_run（含 paused/failed/completed）
    const prior = ctx.db.conn
      .prepare("SELECT node_state FROM job_runs WHERE job_id = ? AND node_state IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(job.id) as { node_state: string } | undefined;
    let state: WorkflowState;
    if (prior) {
      try {
        state = JSON.parse(prior.node_state) as WorkflowState;
      } catch {
        state = initialState(template);
      }
    } else {
      state = initialState(template);
    }

    const engine = new WorkflowEngine(template, this.makeRunner(), payload.topic,
                                      payload.maxInputTokens ?? 400_000);
    const result = await engine.run(state);
    const nodeState = JSON.stringify(result.state);

    if (result.completed && result.report) {
      if (ctx.jobRunId != null) {
        ctx.db.insertArtifact({
          jobRunId: ctx.jobRunId, kind: "report",
          title: `${template.name}：${payload.topic}`,
          content: result.report,
          meta: JSON.stringify({ template: template.id, topic: payload.topic,
                                 inputTokens: result.inputTokens, outputTokens: result.outputTokens }),
        });
      }
      return {
        status: JobStatus.SUCCESS,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        nodeState,
        detail: { report: result.report, tokens: result.inputTokens + result.outputTokens },
      };
    }
    return {
      status: JobStatus.PAUSED,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      error: result.error ?? "工作流未完整执行",
      nodeState,
    };
  }
}
