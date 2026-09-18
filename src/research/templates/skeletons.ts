/** 品牌/企业研究模板：复用同一引擎与节点骨架，仅提示词域不同（引擎零改动）。 */
import type { ResearchTemplate } from "../engine.ts";

function skeleton(id: string, name: string, description: string, dims: string): ResearchTemplate {
  return {
    id, name, description,
    reportFrom: ["fix", "write"],
    nodes: [
      { id: "plan", title: "研究计划", requireSearch: false,
        prompt: `为研究对象「{{task}}」制定检索策略：列出 6~10 条查询词，覆盖维度：${dims}。只输出计划清单。` },
      { id: "research", title: "网络采证", requireSearch: true,
        prompt: `研究对象：{{task}}。\n\n# 检索计划\n{{outputs.plan}}\n\n按计划执行真实检索采证。证据等级：A=官方/一手，B=行业/二次整理，C=社媒待验证。输出格式：\`[编号] 【来源/日期】【等级】 内容。来源：URL\`，≥6 条 A/B 级，推断单独标注「推断：（置信度）」，末尾列 2~3 条数据缺口。` },
      { id: "write", title: "报告写作", requireSearch: true,
        prompt: `基于证据材料为「{{task}}」撰写报告（Markdown）：\n\n{{outputs.research}}\n\n结构：结论先行 → ${dims} 分节论述（挂证据编号）→ 风险与缺口 → 证据附录。禁止引入证据外“记忆事实”。` },
      { id: "validate", title: "质量校验", requireSearch: false,
        prompt: `审查报告：①关键事实均有证据与 URL ②A/B 级 ≥6 条 ③缺口显式。达标只输出 PASS，否则输出 NEED_FIX 并列补证清单（含建议检索词）。\n\n{{outputs.write}}`,
        gate: { node: "write", ran: true } },
      { id: "fix", title: "补证整合", requireSearch: true,
        prompt: `按补证要求真实检索并更新报告：\n\n# 要求\n{{outputs.validate}}\n\n# 原报告\n{{outputs.write}}\n\n输出更新后完整报告，开头列新增证据。`,
        gate: { node: "validate", contains: "NEED_FIX" } },
    ],
  };
}

export const brandTemplate = skeleton("brand-research", "品牌研究",
  "品牌定位、渠道与营销、竞品对比、口碑舆情",
  "品牌定位与主张、产品与价格带、渠道与营销动作、竞品动态、舆情口碑");

export const companyTemplate = skeleton("company-research", "企业研究",
  "经营与融资、组织与人事、产品与市场、风险信号",
  "经营与财务/融资、组织与关键人事、产品市场动态、竞争格局、风险信号");
