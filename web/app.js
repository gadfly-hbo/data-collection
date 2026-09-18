/* 棱镜采集工作台前端逻辑（原生 JS，无构建步骤） */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, options) {
  const resp = await fetch(path, options);
  let body = {};
  try { body = await resp.json(); } catch (_) { /* 非 JSON 响应 */ }
  if (!resp.ok) {
    throw new Error(typeof body.detail === "string" ? body.detail
      : `请求失败（${resp.status}）`);
  }
  return body;
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g,
    (ch) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
      "'": "&#39;"}[ch]));
}

/* 状态 → 中文徽标（Prism：状态带文字，颜色只是辅助） */
const STATUS_LABEL = {
  SUCCESS: ["成功", "ok"],
  SKIPPED_UNCHANGED: ["内容未变", "skip"],
  SKIPPED_NO_CONTENT: ["无正文内容", "skip"],
  SCHEMA_ERROR: ["格式待复核", "warn"],
  FETCH_ERROR: ["抓取失败", "err"],
  BLOCKED: ["被封锁", "err"],
};

function badge(status) {
  const [label, cls] = STATUS_LABEL[status] || [status, "skip"];
  return `<span class="badge badge-${cls}" title="${esc(status)}">${label}</span>`;
}

function intervalLabel(seconds) {
  if (seconds % 86400 === 0) return `每天`;
  if (seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `每 ${seconds / 60} 分钟`;
  return `每 ${seconds} 秒`;
}

/* ---------- 侧边栏导航 ---------- */
$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b === btn));
    $$(".page").forEach((p) =>
      p.classList.toggle("active", p.id === `page-${btn.dataset.page}`));
    if (btn.dataset.page === "runs") refreshRuns();
    if (btn.dataset.page === "data") refreshItems();
    if (btn.dataset.page === "sources") refreshSources();
  });
});

/* ---------- Schema 下拉（来自后端注册表） ---------- */
async function loadSchemas() {
  const data = await api("/api/schemas");
  const names = Object.keys(data);
  for (const sel of [$("#run-schema"), $("#src-schema")]) {
    sel.innerHTML = names
      .map((n) => `<option value="${n}" title="${esc(data[n].description)}">${esc(n)}</option>`)
      .join("");
  }
  for (const sel of [$("#data-schema"), $("#export-schema")]) {
    sel.innerHTML = '<option value="">（全部）</option>' + names
      .map((n) => `<option value="${n}">${esc(n)}</option>`).join("");
  }
}

/* ---------- 今日概览 ---------- */
async function refreshSummary() {
  try {
    const data = await api("/api/summary");
    const s = data.summary;
    $("#summary").innerHTML = `
      <div class="metric"><div class="v">${s.total}</div><div class="k">总任务数</div></div>
      <div class="metric"><div class="v">${Math.round(s.success_rate * 100)}%</div><div class="k">成功率</div></div>
      <div class="metric"><div class="v">${s.today_tasks}</div><div class="k">今日 LLM 任务</div></div>
      <div class="metric"><div class="v">${s.today_input_tokens.toLocaleString()}</div><div class="k">今日 input tokens</div></div>`;
    $("#blocked").style.display = data.blocked.length ? "flex" : "none";
    if (data.blocked.length) {
      $("#blocked").textContent =
        `⚠ 被封锁来源（最近）：${data.blocked.map((b) => b.url).join("、")}`;
    }
  } catch (e) {
    $("#summary").innerHTML = `<p class="hint">加载失败：${esc(e.message)}</p>`;
  }
}

/* ---------- 对话助手 ---------- */
const chatHistory = [];

function addMsg(role, html) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = html;
  $("#chat-log").appendChild(div);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  return div;
}

function planCardHtml(plan) {
  return `
    <div class="plan-card">
      <h3>采集计划（待确认）</h3>
      <dl>
        <dt>来源名称</dt><dd>${esc(plan.name)}</dd>
        <dt>采集网址</dt><dd>${esc(plan.url)}</dd>
        <dt>数据类型</dt><dd>${esc(plan.schema_type)}</dd>
        <dt>采集频率</dt><dd>${intervalLabel(plan.interval_s)}</dd>
        ${plan.instruction ? `<dt>关注点</dt><dd>${esc(plan.instruction)}</dd>` : ""}
        ${plan.use_browser ? `<dt>渲染方式</dt><dd>浏览器渲染（JS 站点）</dd>` : ""}
      </dl>
      <div class="plan-actions">
        <button class="btn btn-primary btn-mini" data-act="confirm-run">✅ 确认创建并立即执行</button>
        <button class="btn btn-secondary btn-mini" data-act="confirm-only">仅创建来源</button>
        <button class="btn btn-mini" data-act="revise">再修改一下</button>
      </div>
    </div>`;
}

function bindPlanCard(container, plan) {
  container.addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "revise") {
      $("#chat-input").focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = "创建中…";
    try {
      const src = await api("/api/sources", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          url: plan.url, name: plan.name, schema_type: plan.schema_type,
          interval_s: plan.interval_s, enabled: true,
          use_browser: plan.use_browser, instruction: plan.instruction || "",
        }),
      });
      if (btn.dataset.act === "confirm-only") {
        addMsg("assistant",
          `已创建来源「${esc(plan.name)}」，${intervalLabel(plan.interval_s)}自动采集。<span class="meta">可在「来源管理」查看或调整。</span>`);
      } else {
        const run = await api("/api/run", {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({source_id: src.id}),
        });
        const detail = run.item
          ? `，提取到「${esc(run.item.title || run.item.headline || "")}」`
          : (run.error ? `（${esc(run.error)}）` : "");
        addMsg("assistant",
          `已创建「${esc(plan.name)}」并完成首次采集：${badge(run.status)}${detail}<span class="meta">tokens ${run.input_tokens}/${run.output_tokens}｜${run.duration_ms}ms</span>`);
      }
      refreshSources(); refreshSummary();
      container.querySelector(".plan-actions").remove();
    } catch (e) {
      addMsg("assistant", `创建失败：${esc(e.message)}`);
      btn.disabled = false;
      btn.textContent = "重试";
    }
  }, {once: false});
}

$("#chat-log").addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-research]");
  if (!btn) return;
  const draft = JSON.parse(btn.dataset.research);
  try {
    const r = await api("/api/research", { method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ template: draft.template, topic: draft.topic }) });
    btn.closest(".plan-actions").innerHTML = `<span class="hint">✅ 已创建 #${r.id} —— </span><button class="btn btn-secondary btn-mini" onclick="go(\x27research\x27)">去研究工作台确认 ▸</button>`;
    refreshOverview && refreshOverview();
  } catch (e) { alert(`创建失败：${e.message}`); }
});

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("#chat-input").value.trim();
  if (!text) return;
  $("#chat-input").value = "";
  addMsg("user", esc(text));
  chatHistory.push({role: "user", content: text});

  const thinking = document.createElement("div");
  thinking.className = "thinking";
  thinking.textContent = "助手思考中…";
  $("#chat-log").appendChild(thinking);
  $("#chat-send").disabled = true;
  try {
    const data = await api("/api/chat", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({history: chatHistory}),
    });
    thinking.remove();
    chatHistory.push({role: "assistant", content: data.reply});
    const msg = addMsg("assistant", esc(data.reply));
    if (data.plan) {
      msg.insertAdjacentHTML("beforeend", planCardHtml(data.plan));
      bindPlanCard(msg, data.plan);
    } else if (data.intent === "research" && data.research) {
      msg.insertAdjacentHTML("beforeend", `
        <div class="plan-card">
          <h3>研究任务草稿（${esc(data.research.template)}）</h3>
          <dl><dt>研究对象</dt><dd>${esc(data.research.topic)}</dd>
              <dt>执行方式</dt><dd>确认后进入研究工作台多节点执行，token 预算默认 25 万</dd></dl>
          <div class="plan-actions">
            <button class="btn btn-primary btn-mini" data-research='${esc(JSON.stringify(data.research))}'>➕ 创建并去确认</button>
          </div>
        </div>`);
    }
  } catch (e) {
    thinking.remove();
    addMsg("assistant", `暂时无法处理：${esc(e.message)}<span class="meta">如提示配额限制，稍后重试即可。</span>`);
  } finally {
    $("#chat-send").disabled = false;
    $("#chat-input").focus();
  }
});

/* ---------- 采集执行 ---------- */
$("#run-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const btn = $("#run-btn");
  btn.disabled = true; btn.textContent = "采集中…";
  const box = $("#run-result");
  box.style.display = "none";
  try {
    const data = await api("/api/run", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        url: $("#run-url").value.trim(),
        schema_type: $("#run-schema").value,
        use_browser: $("#run-browser").checked,
      }),
    });
    const item = data.item;
    const itemRows = item ? Object.entries(item)
      .filter(([k]) => !["source_url", "scraped_at"].includes(k))
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(Array.isArray(v) ? v.join("、") : v)}</td></tr>`)
      .join("") : "";
    box.style.display = "block";
    box.innerHTML = `
      <p>${badge(data.status)}｜${esc(data.url)}｜tokens ${data.input_tokens}/${data.output_tokens}｜${data.duration_ms}ms</p>
      ${data.error ? `<p class="hint">原因：${esc(data.error)}</p>` : ""}
      ${itemRows ? `<table class="table"><tbody>${itemRows}</tbody></table>` : ""}`;
    refreshSummary(); refreshRuns();
  } catch (e) {
    box.style.display = "block";
    box.innerHTML = `<p class="hint">执行失败：${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false; btn.textContent = "▶ 执行采集";
  }
});

/* ---------- 来源管理 ---------- */
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
          <button class="btn btn-secondary btn-mini" data-act="run" data-id="${s.id}">▶ 采集</button>
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
      const data = await api("/api/run", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({source_id: id}),
      });
      alert(`采集完成：${STATUS_LABEL[data.status]?.[0] || data.status}${data.error ? "（" + data.error + "）" : ""}`);
    } else if (btn.dataset.act === "toggle") {
      const sources = await api("/api/sources");
      const src = sources.find((s) => s.id === id);
      await api("/api/sources", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          url: src.url, name: src.name, schema_type: src.schema_type,
          interval_s: src.interval_s, enabled: !src.enabled,
          use_browser: !!src.use_browser, instruction: src.instruction || "",
        }),
      });
    } else if (btn.dataset.act === "delete") {
      if (!confirm("删除该来源后，其关联台账仍保留，但不再自动采集。确认删除？")) return;
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
        url: $("#src-url").value.trim(),
        name: $("#src-name").value.trim() || null,
        schema_type: $("#src-schema").value,
        interval_s: Number($("#src-interval").value),
        enabled: $("#src-enabled").checked,
        use_browser: $("#src-browser").checked,
      }),
    });
    $("#src-url").value = ""; $("#src-name").value = "";
    refreshSources();
  } catch (e) { alert(`保存失败：${e.message}`); }
});

/* ---------- 来源发现（候选 → 确认入库） ---------- */
let discoverCandidates = [];

$("#discover-btn").addEventListener("click", async () => {
  const topic = $("#discover-topic").value.trim();
  const box = $("#discover-results");
  if (!topic) { box.innerHTML = '<p class="hint">请先输入主题。</p>'; return; }
  const btn = $("#discover-btn");
  btn.disabled = true; btn.textContent = "检索中（约 30~90 秒）…";
  box.innerHTML = "";
  try {
    const data = await api("/api/discover", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({topic}),
    });
    if (!data.candidates.length) {
      box.innerHTML = '<p class="hint">未发现合适候选（可换主题重试）。</p>';
      return;
    }
    discoverCandidates = data.candidates;
    box.innerHTML = data.candidates.map((c, i) => `
      <div class="plan-card" data-idx="${i}">
        <h3>候选 ${i + 1}</h3>
        <dl>
          <dt>名称</dt><dd>${esc(c.name)}</dd>
          <dt>网址</dt><dd>${esc(c.url)}</dd>
          <dt>数据类型</dt><dd>${esc(c.schema_type)}</dd>
          <dt>理由</dt><dd>${esc(c.reason)}</dd>
        </dl>
        <div class="plan-actions">
          <button class="btn btn-primary btn-mini" data-act="add">➕ 添加为来源（每天采集）</button>
        </div>
      </div>`).join("");
  } catch (e) {
    box.innerHTML = `<p class="hint">发现失败：${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false; btn.textContent = "🔍 发现来源";
  }
});

$("#discover-results").addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-act='add']");
  if (!btn) return;
  const card = btn.closest(".plan-card");
  const idx = Number(card.dataset.idx);
  const c = discoverCandidates[idx];
  try {
    await api("/api/sources", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({url: c.url, name: c.name, schema_type: c.schema_type,
                            interval_s: 86400, enabled: true}),
    });
    card.querySelector(".plan-actions").innerHTML = '<span class="hint">✅ 已添加（每天 86400s），可在下表调整</span>';
    refreshSources();
  } catch (e) { alert(`添加失败：${e.message}`); }
  void idx;
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
        <summary>#${r.id}　${esc(title)}　<small class="hint">${esc(r.created_at)}｜${esc(r.schema_type)}</small></summary>
        <pre>${esc(JSON.stringify(r.item, null, 2))}</pre>
      </details>`;
    }).join("") || '<p class="hint">无匹配数据</p>';
  } catch (e) { $("#data-total").textContent = `查询失败：${esc(e.message)}`; }
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
  if ($("#page-runs").classList.contains("active")) refreshRuns();
}, 15000);

loadSchemas()
  .then(() => { refreshSummary(); refreshSources(); refreshConnectors(); refreshCustomJobs(); })
  .catch((e) => console.error("初始化失败：", e));

/* ---------- 连接器市场与定制数据任务（Phase 8） ---------- */
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
              ${spec.options
                ? `<select data-param="${esc(key)}">${spec.options.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`
                : `<input type="text" data-param="${esc(key)}">`}
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
          <button data-act="preview" data-id="${j.id}">预览</button>
          ${j.enabled ? `<button data-act="disable" data-id="${j.id}">停用</button>` : ""}
        </td>
      </tr>`).join("");
  } catch (e) { console.error(e); }
}

$("#connector-market").addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-add]");
  if (!btn) return;
  const card = btn.closest(".plan-card");
  const cid = btn.dataset.add;
  const params = {};
  card.querySelectorAll("[data-param]").forEach((el) => { params[el.dataset.param] = el.value; });
  const interval = Number(card.querySelector("[data-interval]").value);
  try {
    await api("/api/jobs", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ connector: cid, params, interval_s: interval }),
    });
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
        : '<p class="hint">尚无数据（任务未到期或抓取失败，见错误列）</p>';
    }
  } catch (e) { alert(`操作失败：${e.message}`); }
});

// 页面切换时刷新连接器/任务（来源管理页）
const _origGo = window.go;
window.go = function (name) {
  _origGo(name);
  if (name === "sources") { refreshConnectors(); refreshCustomJobs(); }
};


/* ---------- 研究工作台（Phase 10 切片2） ---------- */
const JOB_BADGE = {
  success: ["成功", "ok"], running: ["进行中", "warn"], paused: ["待处理", "warn"],
  failed: ["失败", "err"], skipped: ["跳过", "skip"],
};
let researchTimer = null;

async function refreshResearchJobs(openDetail) {
  try {
    const jobs = await api("/api/research/jobs");
    $("#research-table tbody").innerHTML = jobs.map((j) => {
      const [label, cls] = JOB_BADGE[j.last_status] || [j.last_status || "待执行", "skip"];
      let prog = "-";
      if (j.last_state) {
        try {
          const nodes = Object.values(JSON.parse(j.last_state).nodes);
          prog = `${nodes.filter((n) => n.status === "done").length} / ${nodes.length}`;
        } catch { /* ignore */ }
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
        ? `<div class="notice warn">⏸ 暂停：${esc(d.run.error)}
           <button class="btn btn-secondary btn-mini" style="margin-left:auto" onclick="resumeResearch(${id})">▶ 续跑</button></div>` : ""}
      ${d.job.enabled ? "" : `<div class="notice">ℹ 待确认任务：<button class="btn btn-primary btn-mini" onclick="confirmResearch(${id})">确认并开始</button></div>`}
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
    ${gaps ? `<div class="notice warn">⚠ 数据缺口：${esc(gaps.replace(/数据缺口[:：]?\s*/, "").trim().slice(0, 160))}</div>` : ""}
    ${table}
    <details${d.evidence && d.evidence.length ? "" : " open"}><summary>报告全文（Markdown）</summary>
      <pre style="white-space:pre-wrap">${esc(d.report.slice(0, 8000))}</pre></details>
    ${d.artifactId ? `<button class="btn btn-secondary btn-mini" style="margin-top:8px"
      onclick="location.href='/api/export/report/${d.artifactId}'">⬇ 导出报告 .md</button>` : ""}`;
}

const _goPrev = window.go;
window.go = function (name) {
  _goPrev(name);
  if (name === "research") refreshResearchJobs();
};
