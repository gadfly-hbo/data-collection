import { loadDotenv } from "../src/dotenv.ts";
loadDotenv();
if (!process.env.MINIMAX_CN_API_KEY && process.env.MINIMAX_API_KEY) {
  process.env.MINIMAX_CN_API_KEY = process.env.MINIMAX_API_KEY;
}
const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
const { session } = await createAgentSession({});
console.log("model:", session.model?.id);
const events: string[] = [];
session.subscribe((event) => {
  const t = (event as { type?: string }).type ?? "?";
  if (t !== "message_update") events.push(t);
});
await session.prompt("你好，请用一句话确认你能联网搜索（minimax_web_search 工具是否在你的工具列表里）。");
console.log("事件类型:", events.join(","));
const last = session.messages[session.messages.length - 1] as unknown as Record<string, unknown>;
console.log("最后消息 role:", last?.role, "stopReason:", (last as { stopReason?: string })?.stopReason);
console.log("errorMessage:", (last as { errorMessage?: string })?.errorMessage ?? "(无)");
console.log("content types:", Array.isArray(last?.content) ? (last.content as { type?: string }[]).map(b => b.type) : last?.content);
console.log("state tools:", (session.agent?.state?.tools ?? []).map((t: { name?: string }) => t.name).slice(0, 30));
await (session as unknown as { dispose?: () => Promise<void> }).dispose?.();
process.exit(0);
