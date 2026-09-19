/* 研究工作台 */
const JOB_BADGE = { success: ["成功", "ok"], running: ["进行中", "warn"], paused: ["待处理", "warn"],
                     failed: ["失败", "err"], skipped: ["跳过", "skip"] };
let researchTimer = null;

async function refreshResearchJobs(openDetail) {
  try {
    const jobs = await api("/api/research/jobs");
    $("#research-table tbody").innerHTML = jobs.map((j) => {
      const [label, cls] = JOB_BADGE[j.last_status] || [j.last_status || "待执行", "skip"];
      let prog = "-";
      if (j.last_state) {
        try { const nodes = Object.values(JSON.parse(j.last_state).nodes);
              prog = `${nodes.filter((n) => n.status === "done").length} / ${nodes.length}`; } catch { }
      }
      return `<tr style="cursor:pointer" onclick="openResearch(${j.id})">
        <td><b>${esc(j.name ?? "")}</b></td>
        <td><span class="badge badge-${cls}">${esc(label)}</span></td>
        <td>${prog}</td><td>${(j.input_tokens ?? 0) + (j.output_tokens ?? 0)}</td>
        <td>${esc(j.last_run_at ?? "")}</td><td class="go">查看 ▸</td>
      </tr>`;
    }).join("") || '<tr><td colspan="6" class="hint">暂无研究任务——点右上「新建研究」</td></tr>';
    if (openDetail) openResearch(openDetail);
  } catch (e) { console.error(e); }
}

async function openResearch(id) {
  try {
    const d = await api(`/api/research/jobs/${id}`);
    clearInterval(researchTimer);
    const box = $("#research-detail");
    box.style.display = "block";
    const nodes = d.nodes ?? {};
    const order = Object.keys(nodes);
    const running = d.run && d.run.status === "running";
    const firstPending = order.find((k) => nodes[k].status === "pending");
    const doneCount = order.filter((k) => nodes[k].status === "done").length;
    const pct = order.length ? Math.round((doneCount / order.length) * 100) : 0;
    const chain = order.map((k, i) => {
      const st = nodes[k].status;
      const cls = st === "done" ? "done" : (running && k === firstPending) ? "current" : st === "failed" ? "fail" : "";
      const dot = st === "done" ? "✓" : st === "failed" ? "✕" : (running && k === firstPending) ? "●" : String(i + 1);
      const link = i < order.length - 1 ? `<div class="node-link ${st === "done" ? "done" : ""}"></div>` : "";
      const title = (d.nodeTitles && d.nodeTitles[k]) || k;
      return `<div class="node ${cls}"><div class="dot">${dot}</div><div class="label">${esc(title)}</div></div>${link}`;
    }).join("");
    box.innerHTML = `
      <h2 class="card-title">${esc(d.job.name ?? "")} — 执行视图</h2>
      <div class="spectrum" style="position:relative">
        <div style="position:absolute;left:0;top:0;height:4px;width:${pct}%;background:var(--primary);border-radius:2px"></div>
      </div>
      <div class="node-chain">${chain}</div>
      ${d.run && d.run.status === "paused" && d.run.error
        ? `<div class="notice warn">暂停：${esc(d.run.error)}
           <button class="btn btn-secondary btn-mini" style="margin-left:auto" onclick="resumeResearch(${id})">续跑</button></div>` : ""}
      ${d.job.enabled ? "" : `<div class="notice">待确认任务：<button class="btn btn-secondary btn-mini" onclick="confirmResearch(${id})">确认并开始</button></div>`}
      ${renderReport(d)}
      <p class="hint" style="margin-top:8px">状态每 10 秒自动刷新（进行中）</p>`;
    if (running) researchTimer = setInterval(() => openResearch(id), 10000);
  } catch (e) { console.error(e); }
}

async function resumeResearch(id) {
  try { await api(`/api/research/jobs/${id}/resume`, { method: "POST" }); refreshResearchJobs(id); }
  catch (e) { alert(`续跑失败：${e.message}`); }
}
async function confirmResearch(id) {
  try { await api(`/api/research/jobs/${id}/confirm`, { method: "POST" }); refreshResearchJobs(id); }
  catch (e) { alert(`确认失败：${e.message}`); }
}

const TPL_NAME = { "district-research": "商圈研究", "brand-research": "品牌研究", "company-research": "企业研究" };
let tplCache = null;
function toggleNewResearch() {
  const el = $("#new-research");
  el.style.display = el.style.display === "none" ? "block" : "none";
  if (el.innerHTML) return;
  (async () => {
    tplCache = tplCache ?? await api("/api/research/templates");
    el.innerHTML = `
      <h2 class="card-title">新建研究</h2>
      <div class="form-row">
        <div class="field"><label>研究类型</label>
          <select id="nr-template">${tplCache.map((t) => `<option value="${t.id}">${esc(TPL_NAME[t.id] || t.name)}</option>`).join("")}</select></div>
        <div class="field" style="flex:1 1 260px"><label>研究对象</label>
          <input id="nr-topic" type="text" placeholder="如：深圳 · 前海商圈 / 瑞幸咖啡"></div>
        <div class="field"><label>深度（token 预算）</label>
          <select id="nr-budget"><option value="120000">快速（约 8 分钟）</option><option value="250000" selected>标准（约 20 分钟）</option><option value="500000">深度（约 45 分钟）</option></select></div>
        <button class="btn btn-primary" id="nr-create">创建草稿</button>
      </div>
      <p class="page-desc" style="margin-top:8px">创建后为「待确认」，在下方列表点「确认并开始」才执行——确认前零消耗。</p>`;
    $("#nr-create").onclick = async () => {
      try {
        const r = await api("/api/research", { method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({ template: $("#nr-template").value, topic: $("#nr-topic").value.trim(),
                                 max_input_tokens: Number($("#nr-budget").value) }) });
        el.style.display = "none";
        refreshResearchJobs(r.id);
      } catch (e) { alert(`创建失败：${e.message}`); }
    };
  })();
}

const GRADE_BADGE = { A: "teal", B: "brand", C: "warn" };
function renderReport(d) {
  if (!d.report) return "";
  const gaps = (d.report.match(/数据缺口[\s\S]{0,200}/) || [""])[0];
  const table = (d.evidence && d.evidence.length)
    ? `<h2 class="card-title" style="margin-top:12px">证据表（${d.evidence.length} 条）</h2>
       <table class="table"><thead><tr><th style="width:70px">编号</th><th style="width:88px">等级</th>
       <th style="width:170px">来源</th><th>内容</th></tr></thead><tbody>
       ${d.evidence.map((e) => `<tr><td>${esc(e.id)}</td>
         <td><span class="badge badge-${GRADE_BADGE[e.grade] || "skip"}">${esc(e.grade)}级</span></td>
         <td>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.source)}</a>` : esc(e.source)}</td>
         <td>${esc(e.text)}</td></tr>`).join("")}
       </tbody></table>`
    : '<p class="hint" style="margin-top:10px">未解析到结构化证据（旧报告），以下为原文：</p>';
  return `
    ${gaps ? `<div class="notice warn">数据缺口：${esc(gaps.replace(/数据缺口[:：]?\s*/, "").trim().slice(0, 160))}
      <button class="btn btn-secondary btn-mini" style="margin-left:auto" onclick="resumeResearch(${d.job.id})">续跑补证</button></div>` : ""}
    ${table}
    <details${d.evidence && d.evidence.length ? "" : " open"}><summary>报告全文（Markdown）</summary>
      <pre style="white-space:pre-wrap">${esc(d.report.slice(0, 8000))}</pre></details>
    ${d.artifactId ? `<button class="btn btn-secondary btn-mini" style="margin-top:8px"
      onclick="location.href='/api/export/report/${d.artifactId}'">导出报告 · MD</button>` : ""}`;
}
