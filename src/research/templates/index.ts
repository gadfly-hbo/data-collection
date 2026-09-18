/** 研究模板注册表：新增类型 = 新模板文件 + 这里注册一行（引擎与执行器零改动）。 */
import type { ResearchTemplate } from "../engine.ts";
import { districtTemplate } from "./district.ts";
import { brandTemplate, companyTemplate } from "./skeletons.ts";

export const RESEARCH_TEMPLATES: Record<string, ResearchTemplate> = {
  [districtTemplate.id]: districtTemplate,
  [brandTemplate.id]: brandTemplate,
  [companyTemplate.id]: companyTemplate,
};

export function listTemplates() {
  return Object.values(RESEARCH_TEMPLATES).map((t) => ({
    id: t.id, name: t.name, description: t.description,
    nodes: t.nodes.map((n) => ({ id: n.id, title: n.title, requireSearch: !!n.requireSearch })),
  }));
}
