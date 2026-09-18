/** 测试公共工具：临时库 + 本地 HTTP fixture 服务器 + FakeProvider。 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

import type { ExtractionResult, LlmProvider } from "../src/providers/base.ts";
import type { ZodType } from "zod";

/** 本地 HTTP fixture 服务器（0 端口随机分配），handler 决定响应。 */
export async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function sendHtml(res: ServerResponse, html: string, headers: Record<string, string> = {}): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(html);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

/** Fake LLM Provider：results 为每次调用的返回（结果或异常），超长复用最后一个。 */
export class FakeProvider implements LlmProvider {
  readonly name: string;
  calls: { content: string; instruction: string }[] = [];

  constructor(
    private readonly results: (ExtractionResult<unknown> | Error)[],
    name = "fake",
  ) {
    this.name = name;
  }

  async extract<T>(
    content: string,
    _schema: ZodType<T>,
    opts: { instruction?: string } = {},
  ): Promise<ExtractionResult<T>> {
    this.calls.push({ content, instruction: opts.instruction ?? "" });
    const result = this.results[Math.min(this.calls.length - 1, this.results.length - 1)];
    if (result instanceof Error) throw result;
    return result as ExtractionResult<T>;
  }
}

export function fakeResult<T>(item: T, provider = "fake"): ExtractionResult<T> {
  return { item, inputTokens: 11, outputTokens: 7, provider, model: "fake-model" };
}

export function validNewsItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "测试标题",
    summary: "测试摘要",
    topics: ["测试"],
    sentiment: "neutral",
    ...overrides,
  };
}
