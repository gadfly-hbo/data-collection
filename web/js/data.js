/* 运行记录 + 数据浏览 + 导出 */
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

$("#export-form").addEventListener("click", (event) => {
  const fmt = event.target.dataset.fmt;
  if (!fmt) return;
  const params = new URLSearchParams({format: fmt});
  if ($("#export-schema").value) params.set("schema_type", $("#export-schema").value);
  if ($("#export-since").value) params.set("since", $("#export-since").value);
  if ($("#export-until").value) params.set("until", $("#export-until").value);
  window.location.href = `/api/export?${params}`;
});
