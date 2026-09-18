/** 导出结构化数据为 CSV / JSON / Markdown。
 *  用法：node scripts/export-data.ts --format json [--schema-type NewsItem] [--since 2026-09-01] [--out out.json] */
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

import { Database } from "../src/storage/db.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const META_FIELDS = ["id", "run_id", "source_url", "schema_type", "created_at"];

interface ExportRow {
  id: number;
  run_id: number;
  source_url: string;
  schema_type: string;
  created_at: string;
  item: Record<string, unknown>;
}

export function fetchRows(
  db: Database,
  opts: { schemaType?: string; since?: string; until?: string } = {},
): ExportRow[] {
  let sql = "SELECT id, run_id, source_url, schema_type, content, created_at FROM extracted_items WHERE 1 = 1";
  const params: string[] = [];
  if (opts.schemaType) {
    sql += " AND schema_type = ?";
    params.push(opts.schemaType);
  }
  if (opts.since) {
    sql += " AND date(created_at) >= date(?)";
    params.push(opts.since);
  }
  if (opts.until) {
    sql += " AND date(created_at) <= date(?)";
    params.push(opts.until);
  }
  sql += " ORDER BY id";
  return (db.conn.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => ({
    id: r.id as number,
    run_id: r.run_id as number,
    source_url: r.source_url as string,
    schema_type: r.schema_type as string,
    created_at: r.created_at as string,
    item: JSON.parse(r.content as string),
  }));
}

export function toJson(rows: ExportRow[]): string {
  return JSON.stringify({ count: rows.length, items: rows }, null, 2);
}

export function toCsv(rows: ExportRow[]): string {
  const itemKeys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.item)) {
      if (!itemKeys.includes(key)) itemKeys.push(key);
    }
  }
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [META_FIELDS.concat(itemKeys).join(",")];
  for (const row of rows) {
    lines.push(
      META_FIELDS.map((f) => esc(row[f as keyof ExportRow]))
        .concat(itemKeys.map((k) => esc(row.item[k])))
        .join(","),
    );
  }
  // utf-8-sig BOM：Excel 打开中文不乱码
  return "﻿" + lines.join("\n") + "\n";
}

export function toMarkdown(rows: ExportRow[]): string {
  const lines = [`# 采集数据导出（${rows.length} 条）`, ""];
  for (const row of rows) {
    const item = row.item;
    const title = (item.title as string) || (item.headline as string) || `条目 #${row.id}`;
    lines.push(`## ${title}`);
    lines.push(`- 来源：${row.source_url}`);
    lines.push(`- 类型：${row.schema_type}｜采集时间：${row.created_at}`);
    for (const [key, value] of Object.entries(item)) {
      if (key === "title" || key === "headline") continue;
      const text = typeof value === "object" ? JSON.stringify(value) : String(value);
      lines.push(`- ${key}：${text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else args[key] = true;
    }
  }
  return args;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const format = (args.format as string) ?? "json";
  const dbPath = (args.db as string) ?? resolve(REPO_ROOT, "data/collector.db");
  let db: Database;
  try {
    db = new Database(dbPath);
  } catch (e) {
    console.error(`导出失败：数据库不存在或无法打开（${dbPath}）`);
    return 2;
  }
  try {
    const rows = fetchRows(db, {
      schemaType: args["schema-type"] as string | undefined,
      since: args.since as string | undefined,
      until: args.until as string | undefined,
    });
    const renderers: Record<string, (r: ExportRow[]) => string> = {
      csv: toCsv,
      json: toJson,
      markdown: toMarkdown,
    };
    const render = renderers[format];
    if (!render) {
      console.error(`未知格式: ${format}（可选 csv / json / markdown）`);
      return 2;
    }
    const output = render(rows);
    if (args.out) {
      writeFileSync(args.out as string, output, "utf8");
      console.error(`已导出 ${rows.length} 条 → ${args.out}`);
    } else {
      process.stdout.write(output);
    }
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
