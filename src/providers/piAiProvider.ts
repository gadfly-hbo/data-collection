/** 基于 pi-ai 统一目录的 Provider 实现：结构化提取走「Schema 注入 Prompt +
 *  JSON 提取 + zod 强校验」；供应商目录/鉴权/用量统计由 pi-ai 负责。 */
import { createModels, type Models } from "@earendil-works/pi-ai";
import { minimaxCnProvider } from "@earendil-works/pi-ai/providers/minimax-cn";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { ZodError, type ZodType } from "zod";

import { toJsonSchema } from "../models/schemas.ts";
import {
  type ExtractionResult,
  type LlmProvider,
  TransientProviderError,
  UsageReportedError,
} from "./base.ts";
import { extractJsonObject, stripCodeFence } from "./jsonText.ts";

type ProviderFactory = () => unknown; // pi-ai 各 API 族的 Provider 泛型参数不同，统一宽松化

const FACTORIES: Record<string, ProviderFactory> = {
  "minimax-cn": minimaxCnProvider,
  minimax: minimaxProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  openai: openaiProvider,
};

// pi-ai 各通道按自家环境变量约定读 Key；本项目统一沿用 .env 的变量名
const ENV_FALLBACKS: Record<string, string> = {
  MINIMAX_CN_API_KEY: "MINIMAX_API_KEY",
};

const TRANSIENT_MARKERS = [
  "429", "resource_exhausted", "rate limit", "rate_limit", "quota",
  "500", "502", "503", "504", "internal error", "unavailable", "deadline exceeded",
];

function isTransientMessage(message: string): boolean {
  const text = message.toLowerCase();
  return TRANSIENT_MARKERS.some((m) => text.includes(m));
}

export class PiAiProvider implements LlmProvider {
  readonly name: string;
  private models: Models | null = null;
  private model: ReturnType<Models["getModel"]> | null = null;

  private readonly providerKey: string;
  readonly modelId: string;

  constructor(providerKey: string, modelId: string) {
    if (!FACTORIES[providerKey]) throw new Error(`未知 provider: ${providerKey}`);
    this.providerKey = providerKey;
    this.modelId = modelId;
    this.name = providerKey;
  }

  private ensureModel() {
    if (this.model) return this.model;
    for (const [target, source] of Object.entries(ENV_FALLBACKS)) {
      if (!process.env[target] && process.env[source]) {
        process.env[target] = process.env[source];
      }
    }
    const models = createModels();
    models.setProvider(FACTORIES[this.providerKey]() as never);
    const model = models.getModel(this.providerKey as never, this.modelId);
    if (!model) {
      throw new Error(
        `pi-ai 目录中无模型 ${this.providerKey}/${this.modelId}（以 pi-ai 目录为准改 settings.yaml）`,
      );
    }
    this.models = models;
    this.model = model;
    return model;
  }

  async extract<T>(
    content: string,
    schema: ZodType<T>,
    opts: { instruction?: string } = {},
  ): Promise<ExtractionResult<T>> {
    const model = this.ensureModel();
    const instruction = (opts.instruction || "你是信息提取助手。").trim();
    const schemaJson = JSON.stringify(toJsonSchema(schema), null, 2);
    const system =
      `${instruction}\n\n只输出一个符合以下 JSON Schema 的 JSON 对象，` +
      `禁止 Markdown 代码块标记、注释或解释文字：\n${schemaJson}`;

    const resp = await this.models!.completeSimple(model!, {
      systemPrompt: system,
      messages: [{ role: "user", content, timestamp: Date.now() }],
    });

    if (resp.stopReason === "error") {
      const message = (resp as { errorMessage?: string }).errorMessage ?? "未知供应商错误";
      if (isTransientMessage(message)) throw new TransientProviderError(message);
      throw new Error(message);
    }
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")
      .trim();
    if (!text) throw new Error(`供应商返回空响应（stop_reason=${resp.stopReason}）`);

    const inputTokens = resp.usage?.input ?? 0;
    const outputTokens = resp.usage?.output ?? 0;
    const candidate = extractJsonObject(stripCodeFence(text));
    try {
      const item = schema.parse(JSON.parse(candidate));
      return {
        item,
        inputTokens,
        outputTokens,
        provider: this.name,
        model: this.modelId,
      };
    } catch (e) {
      if (e instanceof ZodError || e instanceof SyntaxError) {
        // 校验失败但调用已发生：用量必须带回台账（预算口径）
        throw new UsageReportedError(
          `响应不是合法的提取结果，原始内容片段：${candidate.slice(0, 200)}`,
          inputTokens,
          outputTokens,
        );
      }
      throw e;
    }
  }
}
