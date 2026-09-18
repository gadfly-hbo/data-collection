/** 供应商组装栈：RateLimitedProvider( FallbackProvider( primary, fallback ) )——
 *  令牌桶主动限速在最外；主供应商退避穷尽后切换备用（即使无备用也获得重试）。 */
import type { ZodType } from "zod";

import { withBackoff, TokenBucketLimiter } from "../rateLimiter.ts";
import { PiAiProvider } from "./piAiProvider.ts";
import type { ExtractionResult, LlmProvider } from "./base.ts";
import { TransientProviderError } from "./base.ts";

export class FallbackProvider implements LlmProvider {
  readonly primary: LlmProvider;
  readonly fallback: LlmProvider | null;
  private readonly maxRetries: number;
  private readonly onDegrade?: (from: string, to: string) => void;
  private readonly sleep?: (seconds: number) => Promise<void>;

  constructor(
    primary: LlmProvider,
    fallback: LlmProvider | null = null,
    maxRetries = 5,
    onDegrade?: (from: string, to: string) => void,
    sleep?: (seconds: number) => Promise<void>,
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.maxRetries = maxRetries;
    this.onDegrade = onDegrade;
    this.sleep = sleep;
  }

  get name(): string {
    return this.fallback ? `${this.primary.name}|${this.fallback.name}` : this.primary.name;
  }

  private retry<T>(fn: () => Promise<T>): Promise<T> {
    return withBackoff(fn, {
      maxRetries: this.maxRetries,
      sleep: this.sleep,
      isTransient: (e) => e instanceof TransientProviderError,
    });
  }

  async extract<T>(
    content: string,
    schema: ZodType<T>,
    opts: { instruction?: string } = {},
  ): Promise<ExtractionResult<T>> {
    try {
      return await this.retry(() => this.primary.extract(content, schema, opts));
    } catch (e) {
      if (!(e instanceof TransientProviderError) || !this.fallback) throw e;
      this.onDegrade?.(this.primary.name, this.fallback.name);
      return await this.retry(() => this.fallback!.extract(content, schema, opts));
    }
  }
}

export class RateLimitedProvider implements LlmProvider {
  readonly inner: LlmProvider;
  private readonly limiter: TokenBucketLimiter | null;

  constructor(inner: LlmProvider, rpm?: number) {
    this.inner = inner;
    this.limiter = rpm ? new TokenBucketLimiter(rpm) : null;
  }

  get name(): string {
    return this.inner.name;
  }

  async extract<T>(
    content: string,
    schema: ZodType<T>,
    opts: { instruction?: string } = {},
  ): Promise<ExtractionResult<T>> {
    if (this.limiter) await this.limiter.acquire();
    return this.inner.extract(content, schema, opts);
  }
}

const DEFAULT_MODELS: Record<string, string> = {
  "minimax-cn": "MiniMax-M3",
  google: "gemini-flash-latest", // 以 pi-ai 目录当前可用模型为准
};

interface ProviderSettings {
  primary?: string;
  fallback?: string;
  [key: string]: unknown;
}

/** 按 settings.yaml 的 provider 配置组装栈；全部缺 Key 抛错。 */
export function createProviderStack(providerCfg: ProviderSettings): LlmProvider {
  const problems: string[] = [];
  const built: [string, LlmProvider][] = [];
  for (const name of [providerCfg.primary, providerCfg.fallback]) {
    if (!name) continue;
    const opts = (providerCfg[name] ?? {}) as { model?: string; rpm?: number };
    try {
      built.push([name, new PiAiProvider(name, opts.model ?? DEFAULT_MODELS[name] ?? "")]);
    } catch (e) {
      problems.push(`${name}: ${e}`);
    }
  }
  if (built.length === 0) {
    throw new Error(`无可用 LLM 供应商（检查 .env / 环境变量）：\n  ${problems.join("\n  ")}`);
  }
  const [effectiveName, effective] = built[0];
  const inner = new FallbackProvider(effective, built[1]?.[1] ?? null);
  const rpm = ((providerCfg[effectiveName] ?? {}) as { rpm?: number }).rpm;
  return new RateLimitedProvider(inner, rpm);
}
