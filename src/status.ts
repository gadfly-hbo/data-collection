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

/** Job 生命周期状态机（任务级，job_runs）——与 RunStatus（采集动作级，crawl_runs）
 *  是两个不同粒度的状态机，取值不混用、不新造同义词。 */
export const JobStatus = {
  RUNNING: "running",
  SUCCESS: "success",
  FAILED: "failed",
  PAUSED: "paused", // research 断点：可从 node_state 续跑
  SKIPPED: "skipped", // 预算熔断等未派发
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];
