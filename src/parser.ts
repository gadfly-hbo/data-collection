/** 正文抽取：Readability 识别正文 + turndown 转 Markdown；无正文返回 null。 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });

/** 从 HTML 抽取正文并转为 Markdown。
 *  空输入、纯导航/链接列表等无正文页面返回 null（对应 SKIPPED_NO_CONTENT）。 */
export function extractMarkdown(html: string, url?: string): string | null {
  if (!html || !html.trim()) return null;
  const { document } = parseHTML(html);
  if (url && document.head) {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head.appendChild(base);
  }
  const article = new Readability(document).parse();
  if (!article?.content || !article.textContent || article.textContent.trim().length < 80) {
    return null; // 正文过短视为无正文（列表页/骨架页），省下 LLM 调用
  }
  const markdown = turndown.turndown(article.content).trim();
  if (markdown.length < 80) return null;
  // 链接密度判定（对齐 Python trafilatura favor_precision 的语义）：
  // 非空行中链接行占比过高且行偏短 → 列表页/导航骨架，判无正文省下 LLM 调用
  const lines = markdown.split(/\n+/).filter((l) => l.trim());
  const linkLines = lines.filter((l) => /\]\(http/.test(l));
  const avgLen = markdown.length / Math.max(lines.length, 1);
  if (lines.length >= 5 && linkLines.length / lines.length >= 0.6 && avgLen < 150) {
    return null;
  }
  return markdown;
}
