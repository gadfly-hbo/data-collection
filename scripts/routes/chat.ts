/** 对话助手 + 来源发现 */
import type { Express } from "express";
import { SCHEMA_REGISTRY } from "../../src/models/schemas.ts";
import { planWithUser } from "../../src/planner.ts";
import { TransientProviderError } from "../../src/providers/base.ts";
import type { DaemonContext } from "../run-daemon.ts";

export function registerChatRoutes(
  app: Express,
  ctx: DaemonContext,
  opts: { discover?: (topic: string) => Promise<unknown> } = {},
): void {
  app.post("/api/chat", async (req, res) => {
    const history = (req.body?.history ?? []) as { role?: string; content?: string }[];
    if (!history.length || !history.every((h) => (h.role === "user" || h.role === "assistant") && h.content)) {
      return res.status(422).json({ detail: "对话历史格式不正确" });
    }
    try {
      const reply = await planWithUser(
        ctx.pipeline.provider,
        history as { role: "user" | "assistant"; content: string }[],
        Object.keys(SCHEMA_REGISTRY).sort(),
      );
      if (reply.plan && !SCHEMA_REGISTRY[reply.plan.schema_type]) {
        reply.plan.schema_type = Object.keys(SCHEMA_REGISTRY).sort()[0];
      }
      res.json({ reply: reply.reply, plan: reply.plan,
                 intent: reply.intent ?? "collect", research: reply.research });
    } catch (e) {
      if (e instanceof TransientProviderError) {
        return res.status(503).json({ detail: "LLM 供应商暂时不可用（配额或限流），请稍后重试" });
      }
      throw e;
    }
  });

  app.post("/api/discover", async (req, res) => {
    if (!opts.discover) return res.status(501).json({ detail: "发现功能未启用（SDK 注入缺失）" });
    const topic = (req.body?.topic ?? "").trim();
    if (!topic) return res.status(422).json({ detail: "需要 topic" });
    try {
      res.json({ ok: true, candidates: await opts.discover(topic) });
    } catch (e) {
      res.status(503).json({ detail: e instanceof Error ? e.message : String(e) });
    }
  });
}
