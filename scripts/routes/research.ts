/** 研究任务生命周期 */
import type { Express, Response } from "express";
import { listTemplates, RESEARCH_TEMPLATES } from "../../src/research/templates/index.ts";
import { parseEvidence } from "../../src/research/evidence.ts";
import { Database, retryOnBusy } from "../../src/storage/db.ts";

export function registerResearchRoutes(app: Express, db: Database): void {
  app.get("/api/research/templates", (_req, res) => res.json(listTemplates()));

  app.post("/api/research", (req, res) => {
    const body = req.body ?? {};
    if (!RESEARCH_TEMPLATES[String(body.template ?? "")]) {
      return res.status(400).json({ detail: `未知研究模板: ${body.template}` });
    }
    const topic = String(body.topic ?? "").trim();
    if (topic.length < 2) return res.status(400).json({ detail: "研究对象过短" });
    const jobId = retryOnBusy(() => db.insertJob({
      type: "research", name: `${RESEARCH_TEMPLATES[String(body.template)].name}：${topic}`,
      payload: JSON.stringify({ template: body.template, topic,
                                maxInputTokens: body.max_input_tokens ?? undefined }),
      schedule: JSON.stringify({ kind: "interval", interval_s: 86400 }),
      enabled: false,
    }));
    res.json({ ok: true, id: jobId, status: "pending_confirmation" });
  });

  app.get("/api/research/jobs", (_req, res) => {
    res.json(db.conn.prepare(
      `SELECT j.*,
         (SELECT r.status FROM job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_status,
         (SELECT r.error FROM job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_error,
         (SELECT r.node_state FROM job_runs r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_state
       FROM jobs j WHERE j.type = 'research' ORDER BY j.id`).all());
  });

  app.get("/api/research/jobs/:id", (req, res) => {
    const job = db.getJob(Number(req.params.id));
    if (!job || job.type !== "research") return res.status(404).json({ detail: "研究任务不存在" });
    const run = db.conn.prepare(
      "SELECT id, status, node_state, input_tokens, output_tokens, error, finished_at FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1")
      .get(Number(job.id)) as Record<string, unknown> | undefined;
    const report = db.conn.prepare(
      `SELECT a.id, a.content, a.meta FROM artifacts a JOIN job_runs r ON a.job_run_id = r.id
       WHERE r.job_id = ? AND a.kind = 'report' ORDER BY a.id DESC LIMIT 1`)
      .get(Number(job.id)) as { id: number; content: string; meta: string | null } | undefined;
    let evidence: unknown[] = [];
    if (report) {
      try { evidence = (JSON.parse(String(report.meta ?? "{}")).evidence as unknown[]) ?? []; } catch { }
      if (!evidence.length) evidence = parseEvidence(report.content);
    }
    let nodeTitles: Record<string, string> = {};
    let skeletonTitles: Record<string, string> = {};
    try {
      const tpl = RESEARCH_TEMPLATES[String(JSON.parse(String(job.payload)).template)];
      if (tpl) {
        nodeTitles = Object.fromEntries(tpl.nodes.map((n) => [n.id, n.title]));
        for (const n of tpl.nodes) skeletonTitles[n.id] = "";
      }
    } catch { }
    let nodes: Record<string, { status: string }> = {};
    let progress = { done: 0, total: 0 };
    if (run?.node_state) {
      try {
        nodes = Object.fromEntries(Object.entries(
          (JSON.parse(String(run.node_state)) as { nodes: Record<string, { status: string }> }).nodes)
          .map(([k, v]) => [k, { status: v.status }]));
        progress = { done: Object.values(nodes).filter((n) => n.status === "done").length,
                     total: Object.keys(nodes).length };
      } catch { }
    }
    for (const nid of Object.keys(skeletonTitles)) {
      if (!nodes[nid]) nodes[nid] = { status: "pending" };
      progress = { done: Object.values(nodes).filter((n) => n.status === "done").length, total: Object.keys(nodes).length };
    }
    res.json({ job, run: run ?? null, nodes, nodeTitles, progress, evidence, report: report?.content ?? null, artifactId: report?.id ?? null });
  });

  const researchActivate = (id: number, res: Response) => {
    const job = db.getJob(id);
    if (!job || job.type !== "research") return res.status(404).json({ detail: "研究任务不存在" });
    retryOnBusy(() => db.setJobEnabled(id, true));
    res.json({ ok: true, running: true });
    return undefined;
  };
  app.post("/api/research/jobs/:id/confirm", (req, res) => researchActivate(Number(req.params.id), res));
  app.post("/api/research/jobs/:id/resume", (req, res) => researchActivate(Number(req.params.id), res));
}
