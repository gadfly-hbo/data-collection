/** 数据浏览 + 导出（items / dataset / report / 全格式导出） */
import type { Express } from "express";
import type { Database } from "../../src/storage/db.ts";
import * as queries from "../../src/storage/queries.ts";
import { fetchRows, toCsv, toJson, toMarkdown } from "../export-data.ts";

export function registerDataRoutes(app: Express, db: Database): void {
  app.get("/api/items", (req, res) => {
    const { rows, total } = queries.queryItems(db, {
      schemaType: (req.query.schema_type as string) || undefined,
      keyword: (req.query.keyword as string) || undefined,
      limit: Math.min(Number(req.query.limit ?? 100), 500),
    });
    res.json({ total, items: rows });
  });

  app.get("/api/dataset/:jobId", (req, res) => {
    const job = db.getJob(Number(req.params.jobId));
    if (!job) return res.status(404).json({ detail: "任务不存在" });
    const latest = db.conn.prepare(
      "SELECT id, title, content, meta, created_at FROM artifacts WHERE kind = 'dataset' AND job_run_id IN (SELECT id FROM job_runs WHERE job_id = ?) ORDER BY id DESC LIMIT 1")
      .get(Number(job.id)) as Record<string, unknown> | undefined;
    if (!latest) return res.json({ rows: [], meta: null });
    res.json({ rows: JSON.parse(String(latest.content)),
               meta: JSON.parse(String(latest.meta ?? "null")), created_at: latest.created_at });
  });

  app.get("/api/export", (req, res) => {
    const format = (req.query.format as string) ?? "json";
    const renderers: Record<string, (r: ReturnType<typeof fetchRows>) => string> = {
      csv: toCsv, json: toJson, markdown: toMarkdown,
    };
    const render = renderers[format];
    if (!render) return res.status(400).json({ detail: `未知格式: ${format}` });
    const rows = fetchRows(db, {
      schemaType: req.query.schema_type as string | undefined,
      since: req.query.since as string | undefined,
      until: req.query.until as string | undefined,
    });
    const ext = ({ csv: "csv", json: "json", markdown: "md" } as Record<string, string>)[format];
    const media = ({ csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8",
                     markdown: "text/markdown; charset=utf-8" } as Record<string, string>)[format];
    res.setHeader("Content-Disposition", `attachment; filename="collector.${ext}"`);
    res.type(media).send(render(rows));
  });

  app.get("/api/export/report/:artifactId", (req, res) => {
    const art = db.conn.prepare("SELECT title, content FROM artifacts WHERE id = ? AND kind = 'report'")
      .get(Number(req.params.artifactId)) as { title: string | null; content: string } | undefined;
    if (!art) return res.status(404).json({ detail: "报告不存在" });
    res.setHeader("Content-Disposition", 'attachment; filename="report.md"');
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(`# ${art.title ?? "研究报告"}\n\n${art.content}`);
  });

  app.get("/api/export/dataset/:jobId", (req, res) => {
    const job = db.getJob(Number(req.params.jobId));
    if (!job) return res.status(404).json({ detail: "任务不存在" });
    const arts = db.conn.prepare(
      `SELECT a.content FROM artifacts a JOIN job_runs r ON a.job_run_id = r.id
       WHERE r.job_id = ? AND a.kind='dataset' ORDER BY a.id`).all(Number(job.id)) as { content: string }[];
    const rows = arts.flatMap((a) => { try { return JSON.parse(a.content) as { ts: string; values: Record<string, unknown> }[]; } catch { return []; } });
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r.values ?? {})))];
    const escCell = (v: unknown) => {
      const x = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
    };
    const lines = ["ts," + keys.join(","),
      ...rows.map((r) => [r.ts, ...keys.map((k) => escCell(r.values?.[k]))].join(","))];
    res.setHeader("Content-Disposition", 'attachment; filename="dataset.csv"');
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.send("﻿" + lines.join("\n") + "\n");
  });
}
