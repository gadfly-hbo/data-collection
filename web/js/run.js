/* 临时采集（手动单次） */
$("#run-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const btn = $("#run-btn");
  btn.disabled = true; btn.textContent = "采集中…";
  const box = $("#run-result");
  box.style.display = "none";
  try {
    const data = await api("/api/run", { method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ url: $("#run-url").value.trim(), schema_type: $("#run-schema").value, use_browser: $("#run-browser").checked }) });
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
    refreshOverview(); refreshRuns();
  } catch (e) {
    box.style.display = "block";
    box.innerHTML = `<p class="hint">执行失败：${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false; btn.textContent = "执行采集";
  }
});
