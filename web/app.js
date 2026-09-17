/* 采集控制台前端逻辑（原生 JS，无构建步骤） */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, options) {
  const resp = await fetch(path, options);
  let body = {};
  try { body = await resp.json(); } catch (_) { /* 非 JSON 响应 */ }
  if (!resp.ok) {
    throw new Error(typeof body.detail === "string" ? body.detail : `请求失败（${resp.status}）`);
  }
  return body;
}

function badge(status) {
  const cls = status === "SUCCESS" ? "ok"
    : status.startsWith("SKIPPED") ? "skip"
    : status === "SCHEMA_ERROR" ? "warn" : "err";
  return `<span class="badge ${cls}">${status}</span>`;
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g,
    (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}

/* ---------- 标签页切换 ---------- */
$("#nav").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-tab]");
  if (!btn) return;
  $$("#nav button").forEach((b) => b.classList.toggle("active", b === btn));
  $$(".tab").forEach((sec) => sec.classList.toggle("active", sec.id === `tab-${btn.dataset.tab}`));
});

/* ---------- Schema 下拉（三处共用） ---------- */
async function loadSchemas() {
  const sources = await api("/api/sources");
  void sources;
  // Schema 列表来自后端注册表：经 /api/run 的 400 校验探测过于绕，直接由来源接口回推
  // 这里以固定来源填充：后端 registry 变更时通过 /api/sources 校验提示兜底
  const known = ["NewsItem", "CompetitorEvent"];
  for (const sel of [$("#run-schema"), $("#src-schema"), $("#data-schema"), $("#export-schema")]) {
    const current = sel.id === "data-schema" || sel.id === "export-schema" ? "" : "NewsItem";
    sel.innerHTML = (sel.id === "data-schema" || sel.id === "export-schema"
      ? '<option value="">（全部）</option>' : "")
      + known.map((s) => `<option value="${s}"${s === current ? " selected" : ""}>${s}</option>`).join("");
  }
}

/* ---------- 今日概览 ---------- */
async function refreshSummary() {
  try {
    const data = await api("/api/summary");
    const s = data.summary;
    $("#summary").innerHTML = `
      <div><b>${s.total}</b><span>总任务数</span></div>
      <div><b>${Math.round(s.success_rate * 100)}%</b><span>成功率</span></div>
      <div><b>${s.today_tasks}</b><span>今日 LLM 任务</span></div>
      <div><b>${s.today_input_tokens.toLocaleString()}</b><span>今日 input tokens</span></div>`;
    $("#blocked").textContent = data.blocked.length
      ? `⚠ 被封锁来源（最近）：${data.blocked.map((b) => b.url).join("、")}` : "";
  } catch (e) { $("#summary").textContent = `加载失败：${e.message}`; }
}

/* ---------- 采集执行 ---------- */
$("#run-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const btn = $("#run-btn");
  btn.disabled = true; btn.textContent = "采集中…";
  $("#run-result").className = "result hidden";
  try {
    const body = {
      url: $("#run-url").value.trim(),
      schema_type: $("#run-schema").value,
      use_browser: $("#run-browser").checked,
    };
    const data = await api("/api/run", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    renderRunResult(data);
    refreshSummary(); refreshRuns();
  } catch (e) {
    $("#run-result").className = "result err";
    $("#run-result").innerHTML = `<b>执行失败</b>：${esc(e.message)}`;
  } finally {
    btn.disabled = false; btn.textContent = "▶ 执行采集";
  }
});

function renderRunResult(data) {
  const box = $("#run-result");
  box.className = `result ${data.ok ? "ok" : "err"}`;
  const item = data.item;
  const itemRows = item ? Object.entries(item)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(Array.isArray(v) ? v.join("、") : v)}</td></tr>`)
    .join("") : "";
  box.innerHTML = `
    <p><b>${esc(data.status)}</b>｜${esc(data.url)}｜run_id=${data.run_id ?? "-"}｜
       tokens ${data.input_tokens}/${data.output_tokens}｜${data.duration_ms}ms</p>
    ${data.error ? `<p>错误：${esc(data.error)}</p>` : ""}
    ${itemRows ? `<table class="data"><tbody>${itemRows}</tbody></table>` : ""}`;
}

/* ---------- 来源管理 ---------- */
async function refreshSources() {
  try {
    const sources = await api("/api/sources");
    const tbody = $("#sources-table tbody");
    tbody.innerHTML = sources.map((s) => `
      <tr>
        <td>${s.id}</td><td>${esc(s.name || "")}</td>
        <td>${esc(s.url)}</td><td>${esc(s.schema_type)}</td>
        <td>${s.interval_s}s</td>
        <td>${s.enabled ? "启用" : "停用"}</td>
        <td>${s.last_status ? badge(s.last_status) : "—"}</td>
        <td class="row-actions">
          <button data-act="run" data-id="${s.id}">▶ 采集</button>
          <button data-act="toggle" data-id="${s.id}" data-enabled="${s.enabled ? 1 : 0}">
            ${s.enabled ? "停用" : "启用"}</button>
          <button data-act="delete" data-id="${s.id}" class="danger">删除</button>
        </td>
      </tr>`).join("") || '<tr><td colspan="8" class="hint">暂无来源，请在下方添加</td></tr>';
  } catch (e) { console.error(e); }
}

$("#sources-table").addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-act]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  try {
    if (btn.dataset.act === "run") {
      btn.disabled = true; btn.textContent = "…";
      const data = await api("/api/run", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({source_id: id}),
      });
      alert(`采集完成：${data.status}${data.error ? "（" + data.error + "）" : ""}`);
    } else if (btn.dataset.act === "toggle") {
      const sources = await api("/api/sources");
      const src = sources.find((s) => s.id === id);
      await api("/api/sources", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({url: src.url, name: src.name, schema_type: src.schema_type,
                              interval_s: src.interval_s, enabled: !src.enabled,
                              use_browser: !!src.use_browser, instruction: src.instruction || ""}),
      });
    } else if (btn.dataset.act === "delete") {
      if (!confirm("确认删除该来源？")) return;
      await api(`/api/sources/${id}`, {method: "DELETE"});
    }
    refreshSources(); refreshSummary();
  } catch (e) { alert(`操作失败：${e.message}`); }
});

$("#source-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/sources", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        url: $("#src-url").value.trim(), name: $("#src-name").value.trim() || null,
        schema_type: $("#src-schema").value, interval_s: Number($("#src-interval").value),
        enabled: $("#src-enabled").checked, use_browser: $("#src-browser").checked,
      }),
    });
    $("#src-url").value = ""; $("#src-name").value = "";
    refreshSources();
  } catch (e) { alert(`保存失败：${e.message}`); }
});

/* ---------- 运行记录 ---------- */
async function refreshRuns() {
  try {
    const runs = await api("/api/runs?limit=50");
    $("#runs-table tbody").innerHTML = runs.map((r) => `
      <tr>
        <td>${r.id}</td><td>${esc(r.created_at)}</td><td>${badge(r.status)}</td>
        <td>${esc(r.url)}</td><td>${esc(r.provider || "—")}</td>
        <td>${r.input_tokens}/${r.output_tokens}</td>
        <td>${r.duration_ms}ms</td>
        <td>${esc(r.error_msg || "")}</td>
      </tr>`).join("") || '<tr><td colspan="8" class="hint">暂无运行记录</td></tr>';
  } catch (e) { console.error(e); }
}

$("#runs-refresh").addEventListener("click", refreshRuns);

/* ---------- 数据浏览 ---------- */
$("#data-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await refreshItems();
});

async function refreshItems() {
  const params = new URLSearchParams({limit: "100"});
  if ($("#data-schema").value) params.set("schema_type", $("#data-schema").value);
  if ($("#data-keyword").value.trim()) params.set("keyword", $("#data-keyword").value.trim());
  try {
    const data = await api(`/api/items?${params}`);
    $("#data-total").textContent = `共 ${data.total} 条，显示前 ${data.items.length} 条`;
    $("#data-list").innerHTML = data.items.map((r) => {
      const title = r.item.title || r.item.headline || r.source_url;
      return `<details>
        <summary>#${r.id}　${esc(title)}　<small>${esc(r.created_at)}｜${esc(r.schema_type)}</small></summary>
        <pre>${esc(JSON.stringify(r.item, null, 2))}</pre>
      </details>`;
    }).join("") || '<p class="hint">无匹配数据</p>';
  } catch (e) { $("#data-total").textContent = `查询失败：${e.message}`; }
}

/* ---------- 导出 ---------- */
$("#export-form").addEventListener("click", (event) => {
  const fmt = event.target.dataset.fmt;
  if (!fmt) return;
  const params = new URLSearchParams({format: fmt});
  if ($("#export-schema").value) params.set("schema_type", $("#export-schema").value);
  if ($("#export-since").value) params.set("since", $("#export-since").value);
  if ($("#export-until").value) params.set("until", $("#export-until").value);
  window.location.href = `/api/export?${params}`;
});

/* ---------- 启动 ---------- */
setInterval(() => {
  if ($("#runs-auto").checked && $("#tab-runs").classList.contains("active")) refreshRuns();
}, 15000);

loadSchemas().then(() => {
  refreshSummary(); refreshSources(); refreshRuns();
});
