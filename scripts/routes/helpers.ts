/** 路由共享工具 */
import type { RunOutcome } from "../../src/pipeline.ts";

export function zodDescription(schema: unknown): string {
  return ((schema as { description?: string }).description ?? "").trim();
}

/** RunOutcome → 前端 API 契约（snake_case） */
export function outcomeToApi(outcome: RunOutcome): Record<string, unknown> {
  return {
    status: outcome.status, url: outcome.url, provider: outcome.provider,
    model: outcome.model, input_tokens: outcome.inputTokens,
    output_tokens: outcome.outputTokens, duration_ms: outcome.durationMs,
    error: outcome.error ?? null, run_id: outcome.runId ?? null,
    item: outcome.item ?? null,
  };
}
