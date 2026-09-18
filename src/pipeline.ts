/** 采集流水线主干：fetch → parse → snapshot/dedup → extract → 校验 → 台账。
 *  顺序硬约束（AGENTS.md）：先落快照、过去重闸门，再花 LLM 调用。 */
import { ZodError, type ZodType } from "zod";

import { DedupGate } from "./dedup.ts";
import { Fetcher, FetchStatus } from "./fetcher.ts";
import { extractMarkdown } from "./parser.ts";
import {
  type LlmProvider,
  UsageReportedError,
} from "./providers/base.ts";
import { RunStatus } from "./status.ts";
import type { RunLedger } from "./storage/ledger.ts";
import type { RawStore } from "./storage/rawStore.ts";

export interface TaskSpec {
  url: string;
  schema: ZodType;
  instruction?: string;
  sourceId?: number | null;
  useBrowser?: boolean;
}

export interface RunOutcome {
  status: RunStatus;
  url: string;
  item?: unknown;
  rawHash?: string;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
  durationMs: number;
  error?: string;
  runId?: number;
}

export function isOkOutcome(status: RunStatus): boolean {
  return (
    status === RunStatus.SUCCESS ||
    status === RunStatus.SKIPPED_UNCHANGED ||
    status === RunStatus.SKIPPED_NO_CONTENT
  );
}

const RETRY_HINT =
  "\n\n上一次输出未通过 JSON Schema 校验（{reason}）。请重新输出一个严格符合 Schema 的" +
  " JSON 对象：禁止解释文字、注释与 Markdown 代码块标记。";

function brief(err: unknown, limit = 160): string {
  return String(err instanceof Error ? err.message : err).replace(/\s+/g, " ").slice(0, limit);
}

export class Pipeline {
  readonly fetcher: Fetcher;
  readonly provider: LlmProvider;
  readonly rawStore?: RawStore;
  readonly dedup?: DedupGate;
  readonly ledger?: RunLedger;

  constructor(
    fetcher: Fetcher,
    provider: LlmProvider,
    rawStore?: RawStore,
    dedup?: DedupGate,
    ledger?: RunLedger,
  ) {
    this.fetcher = fetcher;
    this.provider = provider;
    this.rawStore = rawStore;
    this.dedup = dedup;
    this.ledger = ledger;
  }

  async run(task: TaskSpec): Promise<RunOutcome> {
    const start = Date.now();
    let outcome: RunOutcome;
    try {
      outcome = await this.runInner(task);
    } catch (e) {
      // 硬性规则：任何任务的终态都必须入台账。异常统一兑换为 FETCH_ERROR 终态
      outcome = {
        status: RunStatus.FETCH_ERROR,
        url: task.url,
        inputTokens: 0,
        outputTokens: 0,
        provider: "",
        model: "",
        durationMs: 0,
        error: `${e instanceof Error ? e.name : "Error"}: ${brief(e)}`,
      };
    }
    outcome.durationMs = Date.now() - start;
    if (outcome.status === RunStatus.FETCH_ERROR || outcome.status === RunStatus.SCHEMA_ERROR) {
      // 失败任务丢弃条件请求验证器：下次全量重抓重试，防止 304 短路吞掉失败重试
      this.fetcher.discardValidators(task.url);
    }
    if (this.ledger) {
      outcome.runId = this.ledger.record(outcome, schemaName(task.schema), task.sourceId);
    }
    return outcome;
  }

  private async runInner(task: TaskSpec): Promise<RunOutcome> {
    const base = {
      url: task.url,
      inputTokens: 0,
      outputTokens: 0,
      provider: "",
      model: "",
      durationMs: 0,
    };
    const fetched = await this.fetcher.fetch(task.url, { useBrowser: task.useBrowser });
    if (fetched.status === FetchStatus.BLOCKED) {
      return { ...base, status: RunStatus.BLOCKED, error: fetched.reason };
    }
    if (fetched.status === FetchStatus.FETCH_ERROR) {
      return { ...base, status: RunStatus.FETCH_ERROR, error: fetched.reason };
    }
    if (fetched.notModified) {
      // 304：进程内条件请求缓存判定内容未变（成功任务才持有验证器，见 discardValidators）
      return { ...base, status: RunStatus.SKIPPED_UNCHANGED };
    }

    const markdown = extractMarkdown(fetched.html ?? "", fetched.url);
    if (!markdown) return { ...base, status: RunStatus.SKIPPED_NO_CONTENT };

    // 先落快照、过去重闸门，再花 LLM 调用（顺序不可颠倒）
    let rawHash: string | undefined;
    if (this.rawStore) {
      rawHash = this.rawStore.save(markdown);
      if (this.dedup?.seen(task.url, rawHash, schemaName(task.schema))) {
        return { ...base, status: RunStatus.SKIPPED_UNCHANGED, rawHash };
      }
    }

    let result;
    try {
      result = await this.extractWithRetry(markdown, task.schema, task.instruction ?? "");
    } catch (e) {
      if (e instanceof UsageReportedError) {
        return {
          ...base,
          status: RunStatus.SCHEMA_ERROR,
          rawHash,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          error: e.message,
        };
      }
      throw e; // TransientProviderError 等由 run() 兑换为终态
    }

    const item = stamp(result.item as Record<string, unknown>, fetched.url);
    return {
      ...base,
      status: RunStatus.SUCCESS,
      item,
      rawHash,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      provider: result.provider,
      model: result.model,
    };
  }

  /** 提取 + 校验；失败后全新调用一次（附失败原因），两次均失败抛 UsageReportedError。 */
  private async extractWithRetry<T>(
    content: string,
    schema: ZodType<T>,
    instruction: string,
  ) {
    let lastError: unknown = null;
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const instr =
        attempt > 0 && lastError !== null
          ? instruction + RETRY_HINT.replace("{reason}", brief(lastError))
          : instruction;
      try {
        return await this.provider.extract(content, schema, { instruction: instr });
      } catch (e) {
        if (e instanceof UsageReportedError) {
          inputTokens += e.inputTokens;
          outputTokens += e.outputTokens;
          lastError = e;
        } else if (e instanceof ZodError || e instanceof SyntaxError) {
          lastError = e;
        } else {
          throw e;
        }
      }
    }
    throw new UsageReportedError(
      `两次提取均未通过校验: ${brief(lastError)}`,
      inputTokens,
      outputTokens,
    );
  }
}

function schemaName(schema: ZodType): string {
  // 注册表反查类名（台账与去重键使用）
  const found = Object.entries(schemaRegistryRef).find(([, v]) => v === schema);
  return found?.[0] ?? schema.constructor.name;
}

/** pipeline 需要反查注册表名；延迟引入避免循环依赖。 */
import { SCHEMA_REGISTRY as schemaRegistryRef } from "./models/schemas.ts";

function stamp(item: Record<string, unknown>, sourceUrl: string): Record<string, unknown> {
  // 追溯字段以系统为准：LLM 输出中的同名值一律覆盖
  item.source_url = sourceUrl;
  item.scraped_at = new Date().toISOString();
  return item;
}
