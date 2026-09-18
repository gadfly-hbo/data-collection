/** 任务终态台账：所有终态写 crawl_runs，成功路径写 extracted_items。
 *  没有记台账的任务等于没跑（AGENTS.md 硬性规则）。 */
import { createHash } from "node:crypto";

import { RunStatus } from "../status.ts";
import type { Database } from "./db.ts";
import type { RunOutcome } from "../pipeline.ts";

/** 内容去重哈希：排除追溯性易变字段（scraped_at / source_url）后规范化序列化。 */
export function contentDedupHash(schemaType: string, item: Record<string, unknown>): string {
  const payload = { ...item };
  delete payload.scraped_at;
  delete payload.source_url;
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(`${schemaType}:${canonical}`, "utf8").digest("hex");
}

export class RunLedger {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** 写入一条终态台账，返回 run_id；SUCCESS 额外尝试写入 extracted_items。 */
  record(outcome: RunOutcome, schemaType: string, sourceId?: number | null): number {
    const runId = this.db.insertRun({
      url: outcome.url,
      status: outcome.status,
      sourceId: sourceId ?? null,
      rawHash: outcome.rawHash ?? null,
      provider: outcome.provider || null,
      model: outcome.model || null,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      durationMs: outcome.durationMs,
      errorMsg: outcome.error ?? null,
    });
    if (outcome.status === RunStatus.SUCCESS && outcome.item) {
      const item = outcome.item as Record<string, unknown>;
      this.db.insertItem({
        runId,
        sourceUrl: (item.source_url as string) || outcome.url,
        schemaType,
        content: JSON.stringify(item),
        dedupHash: contentDedupHash(schemaType, item),
      });
    }
    return runId;
  }
}
