/* 对话助手 */
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
        <button class="btn btn-primary btn-mini" data-act="confirm-run">确认并执行</button>
        <button class="btn btn-secondary btn-mini" data-act="confirm-only">仅创建来源</button>
        <button class="btn btn-mini" data-act="revise">再修改一下</button>
      </div>
    </div>`;
}

function bindPlanCard(container, plan) {
  container.addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "revise") { $("#chat-input").focus(); return; }
    btn.disabled = true; btn.textContent = "创建中…";
    try {
      const src = await api("/api/sources", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ url: plan.url, name: plan.name, schema_type: plan.schema_type,
          interval_s: plan.interval_s, enabled: true, use_browser: plan.use_browser, instruction: plan.instruction || "" }),
      });
      if (btn.dataset.act === "confirm-only") {
        addMsg("assistant", `已创建来源「${esc(plan.name)}」，${intervalLabel(plan.interval_s)}自动采集。<span class="meta">可在「来源管理」查看或调整。</span>`);
      } else {
        const run = await api("/api/run", { method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({source_id: src.id}) });
        const detail = run.item ? `，提取到「${esc(run.item.title || run.item.headline || "")}」` : (run.error ? `（${esc(run.error)}）` : "");
        addMsg("assistant", `已创建「${esc(plan.name)}」并完成首次采集：${badge(run.status)}${detail}<span class="meta">tokens ${run.input_tokens}/${run.output_tokens}｜${run.duration_ms}ms</span>`);
      }
      refreshSources(); refreshOverview();
      container.querySelector(".plan-actions").remove();
    } catch (e) {
      addMsg("assistant", `创建失败：${esc(e.message)}`);
      btn.disabled = false; btn.textContent = "重试";
    }
  }, {once: false});
}

$("#chat-log").addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-research]");
  if (!btn) return;
  const draft = JSON.parse(btn.dataset.research);
  try {
    const r = await api("/api/research", { method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ template: draft.template, topic: draft.topic, max_input_tokens: 250000 }) });
    btn.closest(".plan-actions").innerHTML = `<span class="hint">已创建 #${r.id} —— </span><button class="btn btn-secondary btn-mini" onclick="go(\x27research\x27)">去研究工作台确认 ▸</button>`;
    refreshOverview();
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
    const data = await api("/api/chat", { method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({history: chatHistory}) });
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
              <dt>执行方式</dt><dd>确认后进入研究工作台多节点执行，token 预算 25 万（标准档）</dd></dl>
          <div class="plan-actions">
            <button class="btn btn-primary btn-mini" data-research='${esc(JSON.stringify(data.research))}'>创建并去确认</button>
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
