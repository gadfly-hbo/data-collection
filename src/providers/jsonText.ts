/** LLM 文本响应中的 JSON 提取工具。 */

export function stripCodeFence(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    const firstBreak = t.indexOf("\n");
    if (firstBreak !== -1) t = t.slice(firstBreak + 1); // 掉落 ```json 等语言标记行
    if (t.trimEnd().endsWith("```")) t = t.trimEnd().slice(0, -3);
  }
  return t.trim();
}

/** 提取第一个完整的最外层 JSON 对象（感知字符串内的花括号与转义）。 */
export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) return text;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}
