/** 对话式采集需求规划器：用户自然语言 → 追问补齐 → 结构化计划草案。 */
import { PlanReply, type PlanReply as PlanReplyT } from "./models/plan.ts";
import type { LlmProvider } from "./providers/base.ts";

const PLANNER_SYSTEM = `你是采集需求助手，服务对象是不懂技术的运营同事。用户用自然语言描述想采集什么信息，
你的任务是对齐需求后整理成采集计划。

对话规则：
- 必须弄清三件事：采集哪个页面（具体 URL）、想要哪类信息、多久采集一次
- URL 缺失或不具体时向用户确认，绝不编造网址；用户只给站点名时请他贴出页面链接
- 数据类型只能从以下可选值中选：{schemas}
- 频率换算：每小时 3600 秒、每天 86400 秒、每周 604800 秒；用户说「实时」就按每小时
- 目标是首页/列表页/需要登录的页面时，把 use_browser 置为 true 并在回复中说明原因
- 信息不齐全时，每轮只问一个最关键的问题；信息齐全时给出计划并附一句确认说明
- 需求是「深入研究/全面分析/多轮对比」这类多步研究（而非盯单个页面）时：intent 填 research、
  research 给出 {template, topic} 草稿（对象：城市·商圈→district-research，品牌→brand-research，
  公司/企业→company-research），plan 保持 null，回复里说明将到研究工作台创建草稿供确认
- 单页盯守/提取类需求：intent 填 collect（默认），按上面规则给 plan
- 全程用简体中文，回复保持简短、口语化，不使用技术术语`;

/** 一轮对话规划。LLM 异常（配额耗尽等）向上抛给调用方处理。 */
export async function planWithUser(
  provider: LlmProvider,
  history: { role: "user" | "assistant"; content: string }[],
  schemaNames: string[],
): Promise<PlanReplyT> {
  const conversation = history
    .map((h) => `${h.role === "user" ? "用户" : "助手"}：${h.content}`)
    .join("\n");
  const result = await provider.extract(conversation, PlanReply, {
    instruction: PLANNER_SYSTEM.replace("{schemas}", schemaNames.join("、")),
  });
  return PlanReply.parse(result.item); // 归一化 default 字段
}
