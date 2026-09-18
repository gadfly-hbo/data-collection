import { describe, expect, it } from "vitest";

import {
  initialState, substitute, validateTemplate, WorkflowEngine,
  type NodeRunner, type ResearchTemplate, type WorkflowState,
} from "../src/research/engine.ts";

function miniTemplate(over: Partial<ResearchTemplate> = {}): ResearchTemplate {
  return {
    id: "t", name: "T", description: "d", reportFrom: ["write"],
    nodes: [
      { id: "plan", title: "计划", requireSearch: false, prompt: "计划：{{task}}" },
      { id: "research", title: "采证", requireSearch: true, prompt: "检索 {{task}}，引用 {{outputs.plan}}" },
      { id: "write", title: "写作", requireSearch: false, prompt: "写 {{outputs.research}}" },
    ],
    ...over,
  };
}

function recordingRunner(outputs: Record<string, string>, tools: string[] = ["minimax_web_search"]) {
  const prompts: string[] = [];
  const vals = Object.values(outputs);
  const runner: NodeRunner = async (prompt) => {
    prompts.push(prompt);
    return { text: vals[prompts.length - 1] ?? "", usedTools: tools, inputTokens: 100, outputTokens: 10 };
  };
  return { runner, prompts };
}

describe("research/engine：工作流引擎", () => {
  it("顺序执行 + {{var}} 替换 + 报告产出", async () => {
    const { runner, prompts } = recordingRunner({});
    const engine = new WorkflowEngine(miniTemplate(), runner, "前海商圈");
    const res = await engine.run(initialState(miniTemplate()));
    expect(res.completed).toBe(true);
    expect(prompts[0]).toContain("计划：前海商圈");
    expect(prompts[1]).toContain("检索 前海商圈，引用 ");
    expect(res.inputTokens).toBe(300);
  });

  it("溯源强制：requireSearch 节点没有检索证据 → 暂停且节点失败", async () => {
    const runner: NodeRunner = async () => ({ text: "编造内容", usedTools: [], inputTokens: 1, outputTokens: 1 });
    const engine = new WorkflowEngine(miniTemplate(), runner, "x");
    const state = initialState(miniTemplate());
    state.nodes.plan = { status: "done", result: { status: "done", output: "p", usedTools: [], inputTokens: 0, outputTokens: 0 } };
    const res = await engine.run(state);
    expect(res.paused).toBe(true);
    expect(res.state.nodes.research.status).toBe("failed");
    expect(res.state.nodes.research.error).toContain("真实检索证据");
  });

  it("断点续跑：done 节点不重跑", async () => {
    const state: WorkflowState = initialState(miniTemplate());
    state.nodes.plan = { status: "done", result: { status: "done", output: "已有计划", usedTools: [], inputTokens: 0, outputTokens: 0 } };
    const seen: string[] = [];
    const runner: NodeRunner = async (p) => { seen.push(p); return { text: "ok", usedTools: ["web_search"], inputTokens: 1, outputTokens: 1 }; };
    await new WorkflowEngine(miniTemplate(), runner, "任务").run(state);
    expect(seen).toHaveLength(2); // plan 未重跑
    expect(seen[0]).toContain("已有计划"); // 变量注入自快照
  });

  it("门控：validate 输出 PASS 时 fix 跳过；NEED_FIX 时执行", async () => {
    const tpl: ResearchTemplate = {
      id: "g", name: "g", description: "", reportFrom: ["fix", "write"],
      nodes: [
        { id: "write", title: "写", requireSearch: false, prompt: "w" },
        { id: "validate", title: "审", requireSearch: false, prompt: "v" },
        { id: "fix", title: "补", requireSearch: false, prompt: "f", gate: { node: "validate", contains: "NEED_FIX" } },
      ],
    };
    for (const verdict of ["PASS", "NEED_FIX 缺数据"]) {
      const ran: string[] = [];
      const runner: NodeRunner = async (p) => {
        ran.push(p);
        const text = p === "v" ? verdict : "out";
        return { text, usedTools: [], inputTokens: 0, outputTokens: 0 };
      };
      const res = await new WorkflowEngine(tpl, runner, "x").run(initialState(tpl));
      expect(res.completed).toBe(true);
      if (verdict === "PASS") {
        expect(ran).not.toContain("f");
        expect(res.report).toBe("out"); // write 兜底
      } else {
        expect(ran).toContain("f");
        expect(res.report).toBe("out");
      }
    }
  });

  it("Token 预算超限 → 暂停（可续跑态）", async () => {
    const { runner } = recordingRunner({});
    const res = await new WorkflowEngine(miniTemplate(), runner, "x", 150).run(initialState(miniTemplate()));
    expect(res.paused).toBe(true);
    expect(res.error).toContain("预算");
  });
});

describe("research/engine：节点重试", () => {
  it("瞬时失败自动重试：第一次抛错第二次成功", async () => {
    let calls = 0;
    const runner: NodeRunner = async () => {
      calls++;
      if (calls === 1) throw new Error("MCP not initialized");
      return { text: "ok", usedTools: ["minimax_web_search"], inputTokens: 1, outputTokens: 1 };
    };
    const res = await new WorkflowEngine(miniTemplate(), runner, "x").run(initialState(miniTemplate()));
    expect(res.completed).toBe(true); // 5 节点全成功（plan/research/write 各至少一次）
  });

  it("重试穷尽才 paused", async () => {
    let calls = 0;
    const runner: NodeRunner = async () => { calls++; throw new Error("always down"); };
    const res = await new WorkflowEngine(miniTemplate(), runner, "x").run(initialState(miniTemplate()));
    expect(res.paused).toBe(true);
    expect(calls).toBe(2); // nodeRetries 默认 2
  });
});

describe("research/engine：模板校验", () => {
  it("gate 引用不存在 → 报错", () => {
    const bad = miniTemplate();
    bad.nodes[2] = { ...bad.nodes[2], gate: { node: "ghost", contains: "x" } };
    expect(() => validateTemplate(bad)).toThrow(/gate/);
  });

  it("substitute 保留未引用变量为占位", () => {
    expect(substitute("{{task}} 与 {{outputs.none}}", "T", { nodes: {} })).toBe("T 与 （无输出）");
  });
});
