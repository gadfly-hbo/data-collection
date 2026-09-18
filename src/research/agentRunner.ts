/** 节点执行器：pi SDK 嵌入（createAgentSession，自动加载 ~/.pi/agent/mcp.json 的
 *  MiniMax MCP），收集真实检索工具调用与 Token 用量。不套壳 CLI。 */
import type { NodeRunner } from "./engine.ts";

export interface AgentSessionLike {
  prompt(text: string): Promise<void>;
  messages: { role?: string; stopReason?: string; errorMessage?: string; usage?: unknown;
              content?: unknown }[];
  subscribe?: (fn: (event: { type?: string; toolCall?: { name?: string } }) => void) => void;
  dispose?: () => Promise<void> | void;
}

export type SessionFactory = () => Promise<AgentSessionLike>;

async function defaultSessionFactory(): Promise<AgentSessionLike> {
  const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
  const { session } = await createAgentSession({});
  return session as unknown as AgentSessionLike;
}

const SYSTEM = "你是研究采证与写作 Agent，服务中文运营人员。必须用 web_search 类工具做实际检索取证，禁止编造来源；全程简体中文；按任务提示词要求的格式输出。";

export function makeAgentRunner(
  opts: { sessionFactory?: SessionFactory; timeoutMs?: number } = {},
): NodeRunner {
  const sessionFactory = opts.sessionFactory ?? defaultSessionFactory;
  const timeoutMs = opts.timeoutMs ?? 300_000;

  return async (prompt: string) => {
    const session = await sessionFactory();
    const usedTools: string[] = [];
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("研究节点超时")), timeoutMs).unref?.());
    try {
      session.subscribe?.((event) => {
        if (event.type === "toolcall_start" && event.toolCall?.name) {
          usedTools.push(event.toolCall.name);
        }
      });
      await Promise.race([session.prompt(`${SYSTEM}\n\n---\n\n${prompt}`), timer]);

      const assistants = session.messages.filter((m) => m.role === "assistant");
      const last = assistants[assistants.length - 1];
      if (last?.stopReason === "error") {
        throw new Error(`供应商错误：${last.errorMessage ?? "未知"}`);
      }
      const text = assistants.flatMap((m) => {
        const content = m.content;
        if (!Array.isArray(content)) return [];
        return (content as { type?: string; text?: string }[])
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text ?? "");
      }).join("\n").trim();
      if (!text) throw new Error("研究节点无文本产出");

      let inputTokens = 0;
      let outputTokens = 0;
      for (const m of assistants) {
        const u = m.usage as { input?: number; output?: number } | undefined;
        inputTokens += u?.input ?? 0;
        outputTokens += u?.output ?? 0;
      }
      return { text, usedTools, inputTokens, outputTokens };
    } finally {
      await session.dispose?.();
    }
  };
}
