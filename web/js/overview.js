/* 总览页 */
async function refreshOverview() {
  try {
    const o = await api("/api/overview");
    $("#ov-metrics").innerHTML = `
      <div class="metric"><div class="v">${o.metrics.today_total}</div><div class="k">今日任务</div></div>
      <div class="metric"><div class="v">${Math.round(o.metrics.today_ok_rate * 100)}%</div><div class="k">正常率</div></div>
      <div class="metric"><div class="v">${o.metrics.today_tokens.toLocaleString()}</div><div class="k">今日 LLM tokens</div></div>
      <div class="metric"><div class="v">${o.scenarios.research.running}</div><div class="k">研究进行中</div></div>`;
    $("#sc-research").textContent = `待确认 ${o.scenarios.research.pendingConfirm} · 暂停 ${o.scenarios.research.paused}`;
    $("#sc-custom").textContent = `活跃任务 ${o.scenarios.custom.active}`;
    $("#sc-adhoc").textContent = `今日采集 ${o.scenarios.adhoc.today} 次`;
    $("#ov-todos").innerHTML = o.todos.length
      ? `<div class="notice warn">待办：${o.todos.map((t) =>
          `<a href="javascript:void(0)" onclick="go('${t.link}')" style="margin-right:10px">${esc(t.text)} →</a>`).join("")}</div>` : "";
  } catch (e) { console.error(e); }
}
