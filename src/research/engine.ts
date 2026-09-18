/** 研究工作流引擎（PLAN §11 / Phase 9）——迁移 flow-center 的引擎语义：
 *  声明式节点、{{var}} 变量传递、失败暂停→断点续跑、检索溯源强制。
 *  节点执行经 NodeRunner 抽象注入（pi SDK agent / 测试 fake），引擎不绑定 LLM。 */
import { z } from "zod";

export const WorkflowNode = z.object({
  id: z.string(),
  title: z.string(),
  /** prompt 模板：{{task}}=研究对象；{{outputs.<nodeId>}}=前序节点输出 */
  prompt: z.string(),
  /** 节点要求真实检索工具证据（flow-center 溯源强制的等价物） */
  requireSearch: z.boolean().default(false),
  /** 门控：gate.node 输出含 gate.contains 才执行；gate.ran=前序节点已执行才执行 */
  gate: z.object({
    node: z.string(),
    contains: z.string().optional(),
    ran: z.boolean().optional(),
  }).optional(),
});
export type WorkflowNode = z.infer<typeof WorkflowNode>;

export const ResearchTemplate = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** 参数 zod（由模板文件自带实例，这里 schema 仅描述） */
  nodes: z.array(WorkflowNode).min(1),
  /** 报告候选（按优先序）：取第一个已执行节点的输出 */
  reportFrom: z.array(z.string()).min(1),
});
export type ResearchTemplate = z.infer<typeof ResearchTemplate>;

export interface NodeRunResult {
  status: "done" | "skipped";
  output?: string;
  usedTools: string[];
  inputTokens: number;
  outputTokens: number;
}

export interface NodeState {
  status: "pending" | "done" | "skipped" | "failed";
  result?: NodeRunResult;
  error?: string;
}

export interface WorkflowState {
  nodes: Record<string, NodeState>;
}

export type NodeRunner = (prompt: string) => Promise<{
  text: string;
  usedTools: string[];
  inputTokens?: number;
  outputTokens?: number;
}>;

export interface EngineResult {
  completed: boolean;
  paused: boolean;
  state: WorkflowState;
  report: string | null;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

/** 模板合法性：节点 id 唯一 + gate 引用存在 */
export function validateTemplate(t: ResearchTemplate): void {
  const ids = t.nodes.map((n) => n.id);
  if (new Set(ids).size !== ids.length) throw new Error(`模板 ${t.id}: 节点 id 重复`);
  for (const n of t.nodes) {
    if (n.gate && !ids.includes(n.gate.node)) {
      throw new Error(`模板 ${t.id}: 节点 ${n.id} 的 gate 引用了不存在的 ${n.gate.node}`);
    }
  }
  for (const rid of t.reportFrom) {
    if (!ids.includes(rid)) throw new Error(`模板 ${t.id}: reportFrom ${rid} 不在节点列表`);
  }
}

export function initialState(template: ResearchTemplate): WorkflowState {
  const nodes: Record<string, NodeState> = {};
  for (const n of template.nodes) nodes[n.id] = { status: "pending" };
  return { nodes };
}

export function substitute(prompt: string, task: string, state: WorkflowState): string {
  return prompt
    .replaceAll("{{task}}", task)
    .replace(/\{\{outputs\.([a-zA-Z0-9_-]+)\}\}/g, (_, nodeId: string) => {
      const out = state.nodes[nodeId]?.result?.output;
      return out ?? "（无输出）";
    });
}

export class WorkflowEngine {
  private readonly template: ResearchTemplate;
  private readonly runner: NodeRunner;
  private readonly task: string;
  /** Token 预算（超出→暂停，可续跑时另行决策） */
  private readonly maxInputTokens: number;

  private readonly nodeRetries: number;

  constructor(template: ResearchTemplate, runner: NodeRunner, task: string,
              maxInputTokens = Infinity, nodeRetries = 2) {
    this.template = template;
    this.runner = runner;
    this.task = task;
    this.maxInputTokens = maxInputTokens;
    this.nodeRetries = Math.max(1, nodeRetries);
  }

  /** 从快照续跑：pending/skipped 节点重新评估，done 直接跳过。
   *  onNode：每个节点进入终态（done/skipped）后回调，用于增量持久化快照。 */
  async run(state: WorkflowState,
          onNode?: (state: WorkflowState, nodeId: string) => void | Promise<void>): Promise<EngineResult> {
    let inputTokens = 0;
    let outputTokens = 0;

    for (const node of this.template.nodes) {
      const st = state.nodes[node.id];
      if (!st) throw new Error(`状态快照缺少节点 ${node.id}`);
      if (st.status === "done" || st.status === "skipped") continue;

      if (node.gate) {
        const gateState = state.nodes[node.gate.node];
        const gateOutput = gateState?.result?.output ?? "";
        if (node.gate.ran && gateState?.status !== "done") {
          st.status = "skipped";
          try { await onNode?.(state, node.id); } catch { /* 忽略 */ }
          continue;
        }
        if (node.gate.contains && !gateOutput.includes(node.gate.contains)) {
          st.status = "skipped"; // 条件未触发（如校验无需补证）
          try { await onNode?.(state, node.id); } catch { /* 忽略 */ }
          continue;
        }
      }

      const prompt = substitute(node.prompt, this.task, state);
      // 节点级重试：MCP/会话偶发初始化竞态不再一击即暂停
      let attemptError: unknown = null;
      for (let attempt = 1; attempt <= this.nodeRetries; attempt++) {
      try {
        const r = await this.runner(prompt);
        if (node.requireSearch && !r.usedTools.some((t) => /search/i.test(t))) {
          st.status = "failed";
          st.error = `节点「${node.title}」未取得真实检索证据，拒绝输出（防模型记忆伪装来源）`;
          return {
            completed: false, paused: true, state, report: null,
            inputTokens, outputTokens, error: st.error,
          };
        }
        st.status = "done";
        st.result = { status: "done", output: r.text, usedTools: r.usedTools,
                      inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0 };
        inputTokens += r.inputTokens ?? 0;
        outputTokens += r.outputTokens ?? 0;
        if (inputTokens > this.maxInputTokens) {
          st.error = "超出 token 预算";
          return { completed: false, paused: true, state, report: null,
                   inputTokens, outputTokens, error: "超出 token 预算" };
        }
        try { await onNode?.(state, node.id); } // 快照写失败不得触发昂贵节点重跑
        catch (e) { console.warn("node snapshot failed:", e); }
        break; // 节点成功：跳出重试循环
      } catch (e) {
        attemptError = e;
        if (attempt < this.nodeRetries) continue;
      }
      }
      if (st.status !== "done") { // 重试穷尽仍失败
        st.status = "failed";
        st.error = `${attemptError}`;
        return { completed: false, paused: true, state, report: null,
                 inputTokens, outputTokens, error: st.error };
      }
    }

    let report: string | null = null;
    for (const candidate of this.template.reportFrom) {
      const st = state.nodes[candidate];
      if (st?.status === "done" && st.result?.output) { report = st.result.output; break; }
    }
    if (report === null) {
      for (let i = this.template.nodes.length - 1; i >= 0; i--) {
        const out = state.nodes[this.template.nodes[i].id]?.result?.output;
        if (out) { report = out; break; }
      }
    }
    return { completed: true, paused: false, state, report, inputTokens, outputTokens };
  }
}
