/* 来源管理 + 连接器市场 + 定制任务 + 来源发现 */
async function refreshSources() {
  try {
    const sources = await api("/api/sources");
    $("#sources-table tbody").innerHTML = sources.map((s) => `
      <tr>
        <td><b>${esc(s.name || "")}</b><br><span class="hint">${esc(s.url)}</span></td>
        <td>${esc(s.schema_type)}</td><td>${intervalLabel(s.interval_s)}</td>
        <td>${s.enabled ? "启用" : "停用"}</td>
        <td>${s.last_status ? badge(s.last_status) : "—"}</td>
        <td>
          <button class="btn btn-secondary btn-mini" data-act="run" data-id="${s.id}">采集</button>
          <button class="btn btn-secondary btn-mini" data-act="toggle" data-id="${s.id}">${s.enabled ? "停用" : "启用"}</button>
          <button class="btn btn-danger btn-mini" data-act="delete" data-id="${s.id}">删除</button>
        </td>
      </tr>`).join("") || '<tr><td colspan="6" class="hint">暂无来源，去「对话助手」描述需求即可创建</td></tr>';
  } catch (e) { console.error(e); }
}

$("#sources-table").addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-act]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  try {
    if (btn.dataset.act === "run") {
      btn.disabled = true; btn.textContent = "…";
      const data = await api("/api/run", { method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({source_id: id}) });
      alert(`采集完成：${STATUS_LABEL[data.status]?.[0] || data.status}${data.error ? "（" + data.error + "）" : ""}`);
    } else if (btn.dataset.act === "toggle") {
      const sources = await api("/api/sources");
      const src = sources.find((s) => s.id === id);
      await api("/api/sources", { method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ url: src.url, name: src.name, schema_type: src.schema_type,
          interval_s: src.interval_s, enabled: !src.enabled, use_browser: !!src.use_browser, instruction: src.instruction || "" }) });
    } else if (btn.dataset.act === "delete") {
      if (!confirm("删除该来源后，其关联台账仍保留，但不再自动采集。确认删除？")) return;
      await api(`/api/sources/${id}`, {method: "DELETE"});
    }
    refreshSources(); refreshOverview();
  } catch (e) { alert(`操作失败：${e.message}`); }
});

$("#source-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/sources", { method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ url: $("#src-url").value.trim(), name: $("#src-name").value.trim() || null,
        schema_type: $("#src-schema").value, interval_s: Number($("#src-interval").value),
        enabled: $("#src-enabled").checked, use_browser: $("#src-browser").checked }) });
    $("#src-url").value = ""; $("#src-name").value = "";
    refreshSources();
  } catch (e) { alert(`保存失败：${e.message}`); }
});

/* 来源发现 */
let discoverCandidates = [];

$("#discover-btn").addEventListener("click", async () => {
  const topic = $("#discover-topic").value.trim();
  const box = $("#discover-results");
  if (!topic) { box.innerHTML = '<p class="hint">请先输入主题。</p>'; return; }
  const btn = $("#discover-btn");
  btn.disabled = true; btn.textContent = "检索中（约 30~90 秒）…";
  box.innerHTML = "";
  try {
    const data = await api("/api/discover", { method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({topic}) });
    if (!data.candidates.length) { box.innerHTML = '<p class="hint">未发现合适候选（可换主题重试）。</p>'; return; }
    discoverCandidates = data.candidates;
    box.innerHTML = data.candidates.map((c, i) => `
      <div class="plan-card" data-idx="${i}">
        <h3>候选 ${i + 1}</h3>
        <dl><dt>名称</dt><dd>${esc(c.name)}</dd><dt>网址</dt><dd>${esc(c.url)}</dd>
            <dt>数据类型</dt><dd>${esc(c.schema_type)}</dd><dt>理由</dt><dd>${esc(c.reason)}</dd></dl>
        <div class="plan-actions"><button class="btn btn-primary btn-mini" data-act="add">添加为来源（每天采集）</button></div>
      </div>`).join("");
  } catch (e) {
    box.innerHTML = `<p class="hint">发现失败：${esc(e.message)}</p>`;
  } finally { btn.disabled = false; btn.textContent = "发现来源"; }
});

$("#discover-results").addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-act='add']");
  if (!btn) return;
  const card = btn.closest(".plan-card");
  const c = discoverCandidates[Number(card.dataset.idx)];
  try {
    await api("/api/sources", { method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({url: c.url, name: c.name, schema_type: c.schema_type, interval_s: 86400, enabled: true}) });
    card.querySelector(".plan-actions").innerHTML = '<span class="hint">已添加（每天 86400s），可在下表调整</span>';
    refreshSources();
  } catch (e) { alert(`添加失败：${e.message}`); }
});

/* 连接器市场 */
async function refreshConnectors() {
  try {
    const list = await api("/api/connectors");
    $("#connector-market").innerHTML = list.map((c) => `
      <div class="plan-card" style="margin:8px 0" data-cid="${esc(c.id)}">
        <h3>${esc(c.name)} <span class="badge badge-skip">${c.api ? "API · 零成本" : "网页"}</span></h3>
        <p class="hint" style="margin:2px 0 8px">${esc(c.description)}</p>
        <div class="form-row">
          ${Object.entries(c.params).map(([key, spec]) => `
            <div class="field"><label>${esc(key)}</label>
              ${spec.options ? `<select data-param="${esc(key)}">${spec.options.map((o) => `<option>${esc(o)}</option>`).join("")}</select>` : `<input type="text" data-param="${esc(key)}">`}
            </div>`).join("")}
          <div class="field"><label>间隔（秒）</label>
            <input type="number" data-interval value="${c.min_interval_s}" min="${c.min_interval_s}" step="60"></div>
          <button class="btn btn-primary btn-mini" data-add="${esc(c.id)}">添加任务</button>
        </div>
      </div>`).join("");
  } catch (e) { console.error(e); }
}

async function refreshCustomJobs() {
  try {
    const jobs = await api("/api/jobs?type=custom");
    $("#custom-jobs-card").style.display = jobs.length ? "block" : "none";
    $("#custom-jobs-table tbody").innerHTML = jobs.map((j) => `
      <tr>
        <td><b>${esc(j.name ?? "")}</b></td>
        <td><span class="badge badge-skip">${esc((j.payload ? JSON.parse(j.payload).connector : "") || "-")}</span></td>
        <td>${intervalLabel(JSON.parse(j.schedule).interval_s)}</td>
        <td>${j.enabled ? "启用" : "停用"}</td>
        <td>${j.last_status ? badge(j.last_status === "success" ? "SUCCESS" : "FETCH_ERROR") : "—"}
            <span class="hint">${esc(j.last_run_at ?? "")}</span></td>
        <td class="row-actions">
          <button data-act="preview" data-id="${j.id}">预览</button> <a class="btn btn-secondary btn-mini" href="/api/export/dataset/${j.id}" download>CSV</a>
          ${j.enabled ? `<button data-act="disable" data-id="${j.id}">停用</button>` : ""}
        </td>
      </tr>`).join("");
  } catch (e) { console.error(e); }
}

$("#connector-market").addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-add]");
  if (!btn) return;
  const card = btn.closest(".plan-card");
  const params = {};
  card.querySelectorAll("[data-param]").forEach((el) => { params[el.dataset.param] = el.value; });
  try {
    await api("/api/jobs", { method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ connector: btn.dataset.add, params, interval_s: Number(card.querySelector("[data-interval]").value) }) });
    btn.textContent = "已添加";
    refreshCustomJobs();
  } catch (e) { alert(`添加失败：${e.message}`); }
});

$("#custom-jobs-table").addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-act]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  try {
    if (btn.dataset.act === "disable") {
      await api(`/api/jobs/${id}`, { method: "DELETE" });
      refreshCustomJobs();
    } else if (btn.dataset.act === "preview") {
      const data = await api(`/api/dataset/${id}`);
      const rows = data.rows.slice(-10);
      $("#dataset-preview").innerHTML = data.rows.length
        ? `<h3 class="card-title" style="margin-top:12px">数据预览（最近 ${rows.length} 条，共 ${data.rows.length} 条）</h3>
           <table class="table"><thead><tr><th>时间</th>${Object.keys(data.rows[0].values).map((k) => `<th>${esc(k)}</th>`).join("")}</tr></thead>
           <tbody>${rows.map((r) => `<tr><td>${esc(r.ts)}</td>${Object.values(r.values).map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
        : '<p class="hint">尚无数据</p>';
    }
  } catch (e) { alert(`操作失败：${e.message}`); }
});
