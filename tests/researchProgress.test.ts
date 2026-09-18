import { describe, expect, it } from "vitest";

import { WorkflowEngine, initialState, type NodeRunner, type WorkflowState } from "../src/research/engine.ts";
import type { ResearchTemplate } from "../src/research/engine.ts";
import { ResearchExecutor } from "../src/jobs/researchExecutor.ts";
import type { JobRow } from "../src/jobs/kernel.ts";
import { JobStatus } from "../src/status.ts";
import { Database } from "../src/storage/db.ts";

const GOOD = "# 深圳前海商圈报告 " + "【等级 A】【等级 B】【等级 A】【等级 B】【等级 C】【等级 A】";

const tpl3: ResearchTemplate = {
  id: "p3", name: "p", description: "", reportFrom: ["w"],
  nodes: [
    { id: "a", title: "A", requireSearch: false, prompt: "a" },
    { id: "b", title: "B", requireSearch: false, prompt: "b" },
    { id: "w", title: "W", requireSearch: false, prompt: "w" },
  ],
};

describe("切片2：节点增量快照", () => {
  it("engine 每节点完成触发 onNode 回调（顺序、含快照）", async () => {
    const seen: string[] = [];
    const runner: NodeRunner = async () => ({ text: "x", usedTools: [], inputTokens: 0, outputTokens: 0 });
    const state = initialState(tpl3);
    await new WorkflowEngine(tpl3, runner, "t").run(state, (s, nodeId) => { seen.push(nodeId); });
    expect(seen).toEqual(["a", "b", "w"]);
  });

  it("executor：district 每节点完成即持久化 job_runs.node_state（非仅终态）", async () => {
    const db = new Database(":memory:");
    const jobId = db.insertJob({ type: "research", name: "r" });
    const runId = db.insertJobRun({ jobId, status: "running" });
    let n = 0;
    const exec = new ResearchExecutor(
      () => async (p: string) => {
        n++;
        return { text: p.includes("基于以下证据") ? GOOD : "步骤输出",
                 usedTools: ["minimax_web_search"], inputTokens: 10, outputTokens: 2 };
      },
      { precheck: async () => ({ ok: true, tools: ["web_search"] }) });
    const job: JobRow = { id: jobId, type: "research", name: "r", ref_id: null,
      payload: JSON.stringify({ template: "district-research", topic: "深圳·前海商圈" }),
      schedule: "{}", enabled: 1 };
    const result = await exec.run(job, { db, jobRunId: runId });
    expect(result.status).toBe(JobStatus.SUCCESS);
    const row = db.conn.prepare("SELECT node_state FROM job_runs WHERE id = ?").get(runId) as { node_state: string };
    const snap = JSON.parse(row.node_state) as { nodes: Record<string, { status: string }> };
    expect(Object.values(snap.nodes).every((v) => v.status === "done" || v.status === "skipped")).toBe(true);
    expect(n).toBeGreaterThanOrEqual(4);
    db.close();
  });

  it("详情端点返回节点摘要（x/y done + 进度）", async () => {
    const db = new Database(":memory:");
    const jobId = db.insertJob({ type: "research", name: "r",
      payload: JSON.stringify({ template: "district-research", topic: "T" }) });
    const runId = db.insertJobRun({ jobId, status: "running",
      nodeState: JSON.stringify({ nodes: {
        plan: { status: "done", result: { output: "x", usedTools: [], inputTokens: 0, outputTokens: 0 } },
        research: { status: "pending" }, write: { status: "pending" },
        validate: { status: "pending" }, fix: { status: "pending" } } }) });
    void runId;
    const { createApp } = await import("../scripts/webapp.ts");
    const ctx = { kernel: null, pipeline: { run: async () => null }, fetcher: null, db,
                  notifyEnabled: false, tickS: 30 } as never;
    const app = createApp(ctx as never, db, { withScheduler: false });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    const detail = await (await fetch(`http://127.0.0.1:${port}/api/research/jobs/${jobId}`)).json();
    expect(detail.progress).toEqual({ done: 1, total: 5 });
    expect(detail.nodeTitles.plan).toBe("研究计划");
    expect(detail.nodes.plan.status).toBe("done");
    expect(detail.nodes.research.status).toBe("pending");
    server.close();
    db.close();
  });
});
