/** 来源发现 Agent：pi SDK 嵌入（createAgentSession），自动加载本机 pi 全局配置
 *  （~/.pi/agent/mcp.json 的 MiniMax MCP），调用 minimax_web_search 检索候选来源。
 *
 *  角色边界：发现层只做低频探索，产出「候选来源」供用户确认；
 *  主采集链路（抓取→提取→落库）保持纯 TS 确定性流水线，Agent 不碰台账写入。 */
import { z } from "zod";

import { extractJsonObject } from "../providers/jsonText.ts";
import type { Database } from "../storage/db.ts";

export const DiscoveredSource = z.object({
  name: z.string().describe("来源名称"),
  url: z.string().describe("页面 URL（http/https）"),
  reason: z.string().describe("推荐理由：内容与主题的关联"),
  schema_type: z.string().describe("建议数据类型（registry 类名）"),
});
export type DiscoveredSource = z.infer<typeof DiscoveredSource>;

export interface DiscoverySession {
  prompt(text: string): Promise<void>;
  messages: { role?: string; content?: unknown }[];
  dispose?: () => Promise<void>;
}

export type SessionFactory = () => Promise<DiscoverySession>;

async function defaultSessionFactory(): Promise<DiscoverySession> {
  const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
  const { session } = await createAgentSession({});
  return session as unknown as DiscoverySession;
}

const DISCOVERY_PROMPT = (topic: string, existing: string[]): string => `你是来源发现助手，为采集系统寻找「${topic}」的优质公开来源。

规则：
1. 用 minimax_web_search 工具做多角度检索（2~4 个不同的查询词），不要凭记忆编造网址
2. 优先选择：稳定更新的资讯页、榜单、官方公告页；排除需要登录、纯视频页、明显采集困难的页面
3. 每个候选给出推荐理由；已是本系统来源的不要重复（现有来源：${existing.join("、") || "（无）"}）
4. 候选数量 3~6 个即可，宁缺毋滥
5. 数据类型建议：资讯/文章类用 NewsItem；公司动态类用 CompetitorEvent

最后一步只输出一个 JSON 数组，每项形如：
[{"name": "来源名", "url": "https://...", "reason": "推荐理由", "schema_type": "NewsItem"}]
不要输出其他解释文字。`;

/** 从文本中提取最外层 JSON 数组（感知字符串内的括号）。 */
export function extractJsonArray(text: string): string {
  const start = text.indexOf("[");
  if (start === -1) return text;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** 从会话消息中取最后一条 assistant 文本。 */
export function extractFinalText(messages: DiscoverySession["messages"]): string {
  const assistants = messages.filter((m) => m.role === "assistant");
  const last = assistants[assistants.length - 1];
  if (!last || !Array.isArray(last.content)) return "";
  return (last.content as { type?: string; text?: string }[])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("")
    .trim();
}

/** 解析候选清单：提取 JSON 数组 → zod 校验 → 非法项丢弃。 */
export function parseCandidates(text: string): DiscoveredSource[] {
  const raw = extractJsonArray(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DiscoveredSource[] = [];
  for (const item of parsed) {
    const result = DiscoveredSource.safeParse(item);
    if (result.success && /^https?:\/\//.test(result.data.url)) out.push(result.data);
  }
  return out;
}

/** 来源发现主流程：检索 → 解析 → 过滤（合法 URL + 未入库）。 */
export async function discoverSources(
  topic: string,
  db: Database,
  opts: { sessionFactory?: SessionFactory } = {},
): Promise<DiscoveredSource[]> {
  const factory = opts.sessionFactory ?? defaultSessionFactory;
  const session = await factory();
  try {
    const existing = (
      db.conn.prepare("SELECT url FROM sources").all() as { url: string }[]
    ).map((r) => r.url);
    await session.prompt(DISCOVERY_PROMPT(topic, existing));
    const finalMessages = session.messages as { role?: string; stopReason?: string; errorMessage?: string }[];
    const lastAssistant = [...finalMessages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant?.stopReason === "error") {
      throw new Error(`供应商错误：${lastAssistant.errorMessage ?? "未知"}（若为配额耗尽，稍后重试）`);
    }
    const text = extractFinalText(session.messages);
    if (!text) throw new Error("发现 Agent 未产出文本结果");
    const candidates = parseCandidates(text);
    return candidates.filter((c) => !db.getSource(c.url)); // 与现有来源去重
  } finally {
    await session.dispose?.();
  }
}
