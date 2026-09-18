/** ResearchExecutor：type=research——工作流引擎 + pi SDK 节点执行器。
 *  快照续跑：取本任务最近一次含 node_state 的 job_runs 作起点；执行结果写入
 *  内核创建的当前 running 行。完成→artifacts(kind=report)；暂停→paused+快照。 */
import { z } from "zod";

import { JobStatus } from "../status.ts";
import { initialState, validateTemplate, WorkflowEngine, type NodeRunner, type WorkflowState } from "../research/engine.ts";
import { assertSearchToolsAvailable, type PrecheckResult } from "../research/mcpPrecheck.ts";
import { parseEvidence } from "../research/evidence.ts";
import { RESEARCH_TEMPLATES } from "../research/templates/index.ts";
import type { Database } from "../storage/db.ts";
import type { JobContext, JobExecutor, JobResult, JobRow } from "./kernel.ts";

const ResearchPayload = z.object({
  template: z.string(),
  topic: z.string(),
  maxInputTokens: z.number().int().positive().optional(),
});

/** 报告质量终检：证据标记与主题相关性——防「机制跑通但内容跑题」 */
export function reportQualityGate(report: string, topic: string): string | null {
  const evidence = (report.match(/【等级\s*[ABC]】/g) ?? []).length;
  if (evidence < 6) return `证据标记不足（【等级 A/B/C】共 ${evidence} 条，要求 ≥6）`;
  const topicTokens = topic.split(/[·\s，,、]+/).filter((t) => t.length >= 2);
  if (topicTokens.length > 0 && !topicTokens.some((t) => report.includes(t))) {
    return `报告未命中研究对象关键词（${topicTokens.join("/") || topic}）`;
  }
  return null; // 通过
}

export class ResearchExecutor implements JobExecutor {
  readonly type = "research";
  private readonly makeRunner: () => NodeRunner;
  private readonly precheck: () => Promise<PrecheckResult>;

  constructor(makeRunner: () => NodeRunner,
              opts: { precheck?: () => Promise<PrecheckResult> } = {}) {
    this.makeRunner = makeRunner;
    this.precheck = opts.precheck ?? (() => assertSearchToolsAvailable());
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

    // 前置条件：检索工具可用（预检失败 → 零消耗暂停，不进入会话降级编证）
    const check = await this.precheck();
    if (!check.ok) {
      return { status: JobStatus.PAUSED,
               error: `检索工具预检失败：${check.error}（工具就绪后重新确认即可续跑）` };
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

    // 初始快照先落库：UI 从第一秒就能渲染完整节点链
    if (ctx.jobRunId != null) {
      ctx.db.conn.prepare("UPDATE job_runs SET node_state = ? WHERE id = ?")
        .run(JSON.stringify(state), ctx.jobRunId);
    }
    const engine = new WorkflowEngine(template, this.makeRunner(), payload.topic,
                                      payload.maxInputTokens ?? 400_000);
    // 增量快照：每节点完成即持久化到当前 running 行（崩溃/长任务可观测）
    const result = await engine.run(state, async (snap, nodeId) => {
      void nodeId;
      if (ctx.jobRunId != null) {
        ctx.db.conn.prepare("UPDATE job_runs SET node_state = ? WHERE id = ?")
          .run(JSON.stringify(snap), ctx.jobRunId);
      }
    });
    const nodeState = JSON.stringify(result.state);

    if (result.completed && result.report) {
      const quality = reportQualityGate(result.report, payload.topic);
      if (quality) {
        return {
          status: JobStatus.PAUSED,
          inputTokens: result.inputTokens, outputTokens: result.outputTokens,
          error: `报告质量终检未通过：${quality}`, nodeState,
        };
      }
      if (ctx.jobRunId != null) {
        ctx.db.insertArtifact({
          jobRunId: ctx.jobRunId, kind: "report",
          title: `${template.name}：${payload.topic}`,
          content: result.report,
          meta: JSON.stringify({ template: template.id, topic: payload.topic,
                                 inputTokens: result.inputTokens, outputTokens: result.outputTokens,
                                 evidence: parseEvidence(result.report) }),
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
