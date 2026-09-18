/** 对话式需求收集的规划模型（zod；不注册进 SCHEMA_REGISTRY） */
import { z } from "zod";

export const CollectionPlan = z.object({
  name: z.string().describe("来源名称，简短易读，如「HackerNews 技术热点」"),
  url: z.string().describe("采集目标页面的完整 URL，http/https 开头"),
  schema_type: z.string().describe("数据类型（对应 registry 注册的类名）"),
  interval_s: z
    .number()
    .int()
    .describe("采集间隔秒数；运营语境换算：每小时 3600、每天 86400、每周 604800"),
  instruction: z.string().default("").describe("附加提取关注点（自然语言）"),
  use_browser: z.boolean().default(false).describe("目标站需要 JS 渲染时为 true"),
});
export type CollectionPlan = z.infer<typeof CollectionPlan>;

export const PlanReply = z.object({
  reply: z
    .string()
    .describe("给用户的中文回复：信息不齐时只提一个最关键的问题；齐全时是一句确认说明"),
  plan: CollectionPlan.nullable().default(null).describe("信息齐全时的计划草案，否则为 null"),
});
export type PlanReply = z.infer<typeof PlanReply>;
