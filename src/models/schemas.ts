/** 提取 Schema（zod）：fields 带中文 description，作为 LLM 提取的语义提示。 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const BaseFields = {
  source_url: z.string().default("").describe("采集来源页面的完整 URL"),
  scraped_at: z
    .string()
    .default(() => new Date().toISOString())
    .describe("抓取时间（UTC，由系统写入）"),
};

export const NewsItem = z.object({
  ...BaseFields,
  title: z.string().describe("资讯标题，精炼保留原意"),
  summary: z.string().describe("内容摘要，2~4 句话概括核心信息"),
  topics: z.array(z.string()).describe("主题标签列表，3~8 个，如 ['AI', '监管']"),
  sentiment: z
    .enum(["positive", "neutral", "negative"])
    .describe("舆情倾向：positive / neutral / negative"),
  published_at: z
    .string()
    .nullable()
    .default(null)
    .describe("发布时间，页面未标注则为 null"),
  author: z.string().nullable().default(null).describe("作者或来源媒体，未标注则为 null"),
});
export type NewsItem = z.infer<typeof NewsItem>;

export const CompetitorEvent = z.object({
  ...BaseFields,
  company: z.string().describe("公司或产品名称"),
  event_type: z
    .enum([
      "product_launch",
      "funding",
      "partnership",
      "leadership_change",
      "financial_report",
      "other",
    ])
    .describe("动态类型：产品发布 / 融资 / 合作 / 人事变动 / 财报 / 其他"),
  headline: z.string().describe("一句话概括该动态"),
  detail: z.string().describe("动态详情，保留关键数字与事实"),
  impact_level: z
    .enum(["high", "medium", "low"])
    .describe("对我方业务的影响程度：high / medium / low"),
  event_date: z.string().nullable().default(null).describe("事件发生日期，未标注则为 null"),
});
export type CompetitorEvent = z.infer<typeof CompetitorEvent>;

export const SCHEMA_REGISTRY: Record<string, z.ZodTypeAny> = {
  NewsItem,
  CompetitorEvent,
};

export function getSchema(name: string): z.ZodTypeAny {
  const schema = SCHEMA_REGISTRY[name];
  if (!schema) {
    throw new Error(`未知 schema_type: ${name}（可用值：${Object.keys(SCHEMA_REGISTRY).join(", ")}）`);
  }
  return schema;
}

/** zod → JSON Schema（注入 LLM prompt / 结构化输出约束用） */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { target: "jsonSchema7" }) as Record<string, unknown>;
}
