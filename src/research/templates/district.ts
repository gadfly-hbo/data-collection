/** 商圈研究模板（自 flow-center district-research 语义迁移）：
 *  计划 → 双分支采证（溯源强制）→ 整合写作 → 质量校验（缺口判定）→ 条件补证。 */
import { z } from "zod";
import type { ResearchTemplate } from "../engine.ts";

export const DistrictParams = z.object({
  topic: z.string().min(2).describe("研究对象：城市·商圈/项目名称"),
});

export const districtTemplate: ResearchTemplate = {
  id: "district-research",
  name: "商圈研究",
  description: "区位与客群、商业生态与竞品、运营表现的多源采证与报告",
  reportFrom: ["fix", "write"],
  nodes: [
    {
      id: "plan",
      title: "研究计划", requireSearch: false,
      prompt: "为研究对象「{{task}}」制定检索策略：列出 6~10 条具体可检索的查询词（覆盖区位规划、交通、住宅与人口、业态与竞品、运营数据），并标注每条对应的证据分支（A=区位与客群 / B=商业生态与竞品）。只输出计划清单。",
    },
    {
      id: "research",
      title: "网络采证",
      requireSearch: true,
      prompt: "研究对象：{{task}}。\n\n# 检索计划\n{{outputs.plan}}\n\n# 职责：按并行两分支执行真实检索采证\n分支 A（区位与客群）：区域规划定位、交通条件、周边住宅分布与价格、人口数据、周边 POI 结构。\n分支 B（商业生态与竞品）：项目体量/开业时间/设计特色/开发商、主力店与品牌组合、业态结构、竞品项目（≥3 个）、运营表现（客流/坪效/出租率，如可获取）。\n\n# 证据等级\nA 级=官方数据/政府公报/权威一手报道；B 级=行业报告/专业平台/二次整理；C 级=论坛/社媒/博客（需交叉验证）。\n\n# 输出格式（严格）\n1. 开头声明已使用 web_search 实际检索。\n2. 按分支 A/B 分组输出证据项：`[A1.1] 【来源名/发布日期】【等级 A】 证据内容。来源：https://...`\n3. 推断必须标注：「推断：…（置信度：高/中/低）」。\n4. 至少 6 条 A/B 级证据；末尾给出 2~3 条数据缺口提示。",
    },
    {
      id: "write",
      title: "报告写作",
      requireSearch: true,
      prompt: "基于以下证据材料为「{{task}}」撰写商圈研究报告（Markdown）：\n\n{{outputs.research}}\n\n# 结构\n1. 结论先行（核心判断 ≤5 条）\n2. 区位与客群（引用 A 分支证据编号）\n3. 商业生态与竞品（引用 B 分支证据编号）\n4. 风险与数据缺口\n5. 附录：证据清单（保留等级与来源 URL）\n\n规则：每个事实必须挂证据编号；推断单独标注；禁止引入证据材料之外的“记忆事实”。",
    },
    {
      id: "validate",
      title: "质量校验", requireSearch: false,
      prompt: "审查以下报告：核对 ① 每个关键事实是否有证据编号与来源 URL；② A/B 级证据是否 ≥6 条；③ 数据缺口是否被显式列出。报告：\n\n{{outputs.write}}\n\n若全部达标，只输出 PASS；否则输出 NEED_FIX 并逐条列出需要补证的问题（含建议检索词）。",
      gate: { node: "write", ran: true },
    },
    {
      id: "fix",
      title: "补证整合",
      requireSearch: true,
      prompt: "针对以下补证要求执行真实网络检索并整合更新：\n\n# 补证要求\n{{outputs.validate}}\n\n# 原报告\n{{outputs.write}}\n\n输出更新后的完整报告（保留证据格式），并在开头列出本轮新增证据。",
      gate: { node: "validate", contains: "NEED_FIX" },
    },
  ],
};
