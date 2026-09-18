/** 任务终态状态机：取值与 PLAN.md §5.5 保持一致，不新造同义词。 */
export const RunStatus = {
  SUCCESS: "SUCCESS",
  FETCH_ERROR: "FETCH_ERROR",
  BLOCKED: "BLOCKED",
  SKIPPED_UNCHANGED: "SKIPPED_UNCHANGED",
  SKIPPED_NO_CONTENT: "SKIPPED_NO_CONTENT",
  SCHEMA_ERROR: "SCHEMA_ERROR",
} as const;

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/** 消耗 LLM 调用的终态：预算统计与面板 Token 口径的唯一依据 */
export const BILLABLE_STATUSES: readonly RunStatus[] = ["SUCCESS", "SCHEMA_ERROR"];
