/** LLM Provider 抽象：其余代码只依赖本接口（供应商可替换性的边界）。
 *  底层统一走 pi-ai 的 provider 目录。 */
import type { ZodType } from "zod";

export interface ExtractionResult<T> {
  item: T;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
}

/** 供应商侧可重试的瞬态错误（429 / 5xx / 网络抖动），由退避层处理。 */
export class TransientProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientProviderError";
  }
}

/** 携带实际 Token 用量的非瞬态错误（如输出未通过校验）。
 *  校验失败时响应已消耗完整调用，用量必须带回 pipeline 记入台账。 */
export class UsageReportedError extends Error {
  readonly inputTokens: number;
  readonly outputTokens: number;

  constructor(message: string, inputTokens = 0, outputTokens = 0) {
    super(message);
    this.name = "UsageReportedError";
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
  }
}

export interface LlmProvider {
  readonly name: string;
  extract<T>(
    content: string,
    schema: ZodType<T>,
    opts?: { instruction?: string },
  ): Promise<ExtractionResult<T>>;
}
