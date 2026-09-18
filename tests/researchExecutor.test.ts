import { describe, expect, it } from "vitest";

import { CustomExecutor } from "../src/jobs/customExecutor.ts";
import type { JobRow } from "../src/jobs/kernel.ts";
import { reportQualityGate, ResearchExecutor } from "../src/jobs/researchExecutor.ts";
import { initialState } from "../src/research/engine.ts";
import { RESEARCH_TEMPLATES } from "../src/research/templates/index.ts";
import { JobStatus } from "../src/status.ts";
import { Database } from "../src/storage/db.ts";

const tpl = "district-research";

function jobRow(payload: unknown): JobRow {
  return { id: 1, type: "research", name: "r", ref_id: null,
           payload: JSON.stringify(payload), schedule: '{"kind":"interval","interval_s":86400}',
           enabled: 1 };
}

/** 假节点执行器：按节点顺序返回可控文本（research 带检索工具） */
function fakeRunner(script: Record<string, { text: string; tools?: string[] }>) {
  const calls: string[] = [];
  return {
    calls,
    make: () => async (prompt: string) => {
      const key = Object.keys(script).find((k) => prompt.startsWith(k) || prompt.includes(`「${k}」`)) ?? "default";
      calls.push(key);
      const step = script[key];
      const isResearch = /检索|采证/.test(prompt);
      const tools = step.tools ?? (isResearch ? ["minimax_web_search"] : []);
      return { text: step.text, usedTools: tools, inputTokens: 200, outputTokens: 20 };
    },
  };
}

describe("jobs/researchExecutor", () => {
  it("完成：报告 artifact + job_runs 终态与 tokens", async () => {
    const db = new Database(":memory:");
    const jobId = db.insertJob({ type: "research", name: "r",
      payload: JSON.stringify({ template: tpl, topic: "前海商圈" }) });
    const runId = db.insertJobRun({ jobId, status: "running" });
    const runner = fakeRunner({
      "计划：": { text: "PLAN", tools: [] },
      "检索计划": { text: "EVIDENCE A1.1", tools: [] },
      "基于以下证据": { text: "# 前海商圈报告", tools: [] },
      "审查以下报告": { text: "PASS", tools: [] },
    });
    // 简化：以全节点通用 script（文本按序）
    const seqRunner = (() => {
      let i = 0;
      const outs = ["PLAN", "EVIDENCE[A1.1] web_search 取证完成 '# 前海商圈报告 【等级 A】【等级 B】【等级 A】【等级 B】【等级 C】【等级 A】'", '# 前海商圈报告 【等级 A】【等级 B】【等级 A】【等级 B】【等级 C】【等级 A】', "PASS"];
      const seen: string[] = [];
      return { seen, make: async () => ({ text: outs[Math.min(i++, 3)], usedTools: ["minimax_web_search"], inputTokens: 200, outputTokens: 20 }) };
    })();
    void runner;
    const exec = new ResearchExecutor(() => seqRunner.make, { precheck: async () => ({ ok: true, tools: ["web_search"] }) });
    const result = await exec.run(jobRow({ template: tpl, topic: "前海商圈" }), { db, jobRunId: runId });

    expect(result.status).toBe(JobStatus.SUCCESS);
    expect(result.inputTokens).toBe(800);
    expect(result.nodeState).toBeTruthy();
    const art = db.conn.prepare("SELECT * FROM artifacts WHERE kind = 'report'").get() as Record<string, unknown>;
    expect(art).toBeTruthy();
    expect(String(art.content)).toContain("报告");
    expect(String(art.title)).toContain("前海商圈");
    db.close();
  });

  it("暂停：research 节点无检索证据 → paused + 快照（可续跑）", async () => {
    const db = new Database(":memory:");
    const jobId = db.insertJob({ type: "research", name: "r" });
    const runId = db.insertJobRun({ jobId, status: "running" });
    const exec = new ResearchExecutor(() => async () => ({ text: "编造", usedTools: [], inputTokens: 0, outputTokens: 0 }), { precheck: async () => ({ ok: true, tools: ["web_search"] }) });
    const result = await exec.run(jobRow({ template: tpl, topic: "x" }), { db, jobRunId: runId });
    expect(result.status).toBe(JobStatus.PAUSED);
    expect(result.error).toContain("检索证据");
    const snapshot = JSON.parse(result.nodeState!) as { nodes: Record<string, { status: string }> };
    expect(snapshot.nodes.plan.status).toBe("done");
    expect(snapshot.nodes.research.status).toBe("failed");
    db.close();
  });

  it("续跑：从最近带快照的 job_run 继续，done 节点不重跑", async () => {
    const db = new Database(":memory:");
    const jobId = db.insertJob({ type: "research", name: "r" });
    const state = initialState(RESEARCH_TEMPLATES[tpl]);
    state.nodes.plan = { status: "done", result: { status: "done", output: "旧计划", usedTools: [], inputTokens: 1, outputTokens: 1 } };
    const oldRun = db.insertJobRun({ jobId, status: "paused", nodeState: JSON.stringify(state) });
    void oldRun;
    const runId = db.insertJobRun({ jobId, status: "running" });
    const seenPrompts: string[] = [];
    const exec = new ResearchExecutor(() => async (p: string) => {
      seenPrompts.push(p);
      return { text: p.includes("基于以下证据") ? '# 前海商圈报告 【等级 A】【等级 B】【等级 A】【等级 B】【等级 C】【等级 A】' : "x", usedTools: ["minimax_web_search"], inputTokens: 0, outputTokens: 0 };
    }, { precheck: async () => ({ ok: true, tools: ["web_search"] }) });
    const result = await exec.run(jobRow({ template: tpl, topic: "x" }), { db, jobRunId: runId });
    expect(result.status).toBe(JobStatus.SUCCESS);
    expect(seenPrompts.some((p) => p.includes("PLAN") || p.includes("旧计划"))).toBe(true); // 快照变量注入
    expect(seenPrompts).toHaveLength(3); // plan done 不重跑；fix 被门控跳过（validate 输出无 NEED_FIX）
    db.close();
  });

  it("payload 非法/未知模板 → failed", async () => {
    const db = new Database(":memory:");
    const exec = new ResearchExecutor(() => async () => ({ text: "", usedTools: [] }));
    const ctx = { db };
    expect((await exec.run(jobRow({ nope: 1 }), ctx)).status).toBe(JobStatus.FAILED);
    expect((await exec.run(jobRow({ template: "ghost", topic: "ab" }), ctx)).status).toBe(JobStatus.FAILED);
    db.close();
  });
});

describe("researchExecutor：预检与质量终检", () => {
  it("预检失败 → paused 且零 token 消耗、不进会话", async () => {
    const db = new Database(":memory:");
    const jobId = db.insertJob({ type: "research", name: "r" });
    const runId = db.insertJobRun({ jobId, status: "running" });
    let runnerCalls = 0;
    const exec = new ResearchExecutor(() => async () => { runnerCalls++; return { text: "x", usedTools: [] }; },
      { precheck: async () => ({ ok: false, tools: [], error: "MCP 未暴露 web_search" }) });
    const r = await exec.run(jobRow({ template: "district-research", topic: "x" }), { db, jobRunId: runId });
    expect(r.status).toBe(JobStatus.PAUSED);
    expect(r.error).toContain("预检失败");
    expect(runnerCalls).toBe(0);
    db.close();
  });

  it("报告质量终检：证据不足/跑题 → paused；达标 → report artifact", async () => {
    expect(reportQualityGate("正文 前海 商圈", "深圳·前海商圈")).toContain("证据标记不足");
    const good = ["【等级 A】", "【等级 B】", "【等级 A】", "【等级 B】", "【等级 C】", "【等级 A】"]
      .map((g, i) => `[A${i}] 【来源${i}】 ${g} 行业事实。来源：https://x/${i}]`).join("\n");
    expect(reportQualityGate(`# 前海商圈\n${good}`, "深圳·前海商圈")).toBeNull();
    expect(reportQualityGate(`# 无关主题\n${good}`, "深圳·前海商圈")).toContain("未命中");
  });
});
