"use strict";
/* 共享工具 + 导航分发器 */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, options) {
  const resp = await fetch(path, options);
  let body = {};
  try { body = await resp.json(); } catch (_) { }
  if (!resp.ok) {
    throw new Error(typeof body.detail === "string" ? body.detail : `请求失败（${resp.status}）`);
  }
  return body;
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g,
    (ch) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch]));
}

const STATUS_LABEL = {
  SUCCESS: ["成功", "ok"], SKIPPED_UNCHANGED: ["内容未变", "skip"],
  SKIPPED_NO_CONTENT: ["无正文内容", "skip"], SCHEMA_ERROR: ["格式待复核", "warn"],
  FETCH_ERROR: ["抓取失败", "err"], BLOCKED: ["被封锁", "err"],
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

async function loadSchemas() {
  const data = await api("/api/schemas");
  const names = Object.keys(data);
  for (const sel of [$("#run-schema"), $("#src-schema")]) {
    sel.innerHTML = names.map((n) => `<option value="${n}" title="${esc(data[n].description)}">${esc(n)}</option>`).join("");
  }
  for (const sel of [$("#data-schema"), $("#export-schema")]) {
    sel.innerHTML = '<option value="">（全部）</option>' + names.map((n) => `<option value="${n}">${esc(n)}</option>`).join("");
  }
}

/** 统一页面分发器 */
function go(name) {
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${name}`));
  window.scrollTo(0, 0);
  if (name === "runs") refreshRuns();
  if (name === "data") refreshItems();
  if (name === "sources") { refreshSources(); refreshConnectors(); refreshCustomJobs(); }
  if (name === "overview") refreshOverview();
  if (name === "research") refreshResearchJobs();
}
$$(".nav-item").forEach((btn) => btn.addEventListener("click", () => go(btn.dataset.page)));
