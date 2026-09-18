/** live 冒烟：真实 LLM 提取（pi-ai → MiniMax-CN）。配额耗尽时优雅跳过。 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDotenv } from "../../src/dotenv.ts";
import { NewsItem } from "../../src/models/schemas.ts";
import { PiAiProvider } from "../../src/providers/piAiProvider.ts";
import { TransientProviderError } from "../../src/providers/base.ts";

const SAMPLE =
  "2026 年 9 月 15 日，Acme 公司宣布正式推出新一代数据平台 Horizon，" +
  "并同步完成 2 亿美元 C 轮融资。公司称本季度营收同比增长 45%，" +
  "新平台将首先面向制造业客户开放。";

describe("live：pi-ai 真实提取", () => {
  beforeAll(() => {
    loadDotenv(resolve(import.meta.dirname, "../../.env"));
    if (!process.env.MINIMAX_API_KEY && !process.env.MINIMAX_CN_API_KEY) {
      throw new Error("skip: 需要 MINIMAX_API_KEY（写入 .env）");
    }
  });

  it("样例正文 → NewsItem 强类型对象", async () => {
    const provider = new PiAiProvider("minimax-cn", "MiniMax-M3");
    let result;
    try {
      result = await provider.extract(SAMPLE, NewsItem, {
        instruction: "从以下正文提取行业资讯",
      });
    } catch (e) {
      if (e instanceof TransientProviderError) {
        console.warn(`[live skip] MiniMax 配额/限流：${e.message.slice(0, 80)}`);
        return;
      }
      throw e;
    }
    if (!result) return;
    expect(result.item.title).toBeTruthy();
    expect(result.item.sentiment).toMatch(/positive|neutral|negative/);
    console.log(`[live] tokens: ${result.inputTokens} in / ${result.outputTokens} out`);
  });
});
