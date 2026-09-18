/** Search 工具预检：独立直连 MiniMax MCP（stdio）确认 web_search 真实可用，
 *  再开始研究工作流——把「工具不可用」从静默降级编证变成显式前置失败。 */
export interface PrecheckResult {
  ok: boolean;
  tools: string[];
  error?: string;
}

export interface PrecheckOptions {
  timeoutMs?: number;
  /** 测试注入：返回 fake client（{ connect, listTools, close }） */
  clientFactory?: () => Promise<{
    listTools(): Promise<{ tools: { name: string }[] }>;
    close(): Promise<void>;
  }>;
}

async function defaultConnect(timeoutMs: number) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js");
  const host = process.env.MINIMAX_API_HOST ?? "https://api.minimaxi.com";
  const transport = new StdioClientTransport({
    command: "uvx",
    args: ["--with", "mcp<2", "minimax-coding-plan-mcp", "-y"],
    env: {
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY ?? "",
      MINIMAX_API_HOST: host,
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "collector-precheck", version: "0.1.0" });
  await withTimeout(client.connect(transport), timeoutMs, "MCP 连接");
  return client;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}超时（${ms}ms）`)), ms);
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** 若缺少 MINIMAX_API_KEY 直接失败（不 spawn）。 */
export async function assertSearchToolsAvailable(opts: PrecheckOptions = {}): Promise<PrecheckResult> {
  if (!opts.clientFactory && !process.env.MINIMAX_API_KEY) {
    return { ok: false, tools: [], error: "缺少 MINIMAX_API_KEY（写入 .env）" };
  }
  const timeoutMs = opts.timeoutMs ?? 90_000; // uvx 冷启动含依赖解析
  let client: { listTools(): Promise<{ tools: { name: string }[] }>; close(): Promise<void> };
  try {
    client = opts.clientFactory
      ? await opts.clientFactory()
      : await defaultConnect(timeoutMs);
  } catch (e) {
    return { ok: false, tools: [], error: `MCP 预检失败：${e}` };
  }
  try {
    const { tools } = await withTimeout(client.listTools(), timeoutMs, "tools/list");
    const names = tools.map((t) => t.name);
    const ok = names.some((n) => /web_search/i.test(n));
    return {
      ok, tools: names,
      error: ok ? undefined : `MCP 未暴露 web_search（实际：${names.join(", ") || "空"}）`,
    };
  } catch (e) {
    return { ok: false, tools: [], error: `MCP 预检失败：${e}` };
  } finally {
    try { await client.close(); } catch { /* 忽略 */ }
  }
}
