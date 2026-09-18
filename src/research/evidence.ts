/** 证据行解析：从采证/补证节点输出提取结构化证据（服务端解析一次，前端降级渲染）。 */
export interface EvidenceRow {
  id: string;
  grade: "A" | "B" | "C";
  source: string;
  text: string;
  url: string;
}

const LINE = /^\s*\[([A-Za-z0-9._-]+)\]\s*【([^/】]+)(?:\/([^】]*))?】【等级\s*([ABC])】\s*(.+?)(?:来源：\s*(https?:\/\/\S+))?\s*$/;

export function parseEvidence(text: string): EvidenceRow[] {
  const out: EvidenceRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const [, id, source, date, grade, body, url] = m;
    out.push({
      id, grade: grade as "A" | "B" | "C",
      source: date ? `${source}/${date}` : source,
      text: body.trim(), url: url ?? "",
    });
  }
  return out;
}
