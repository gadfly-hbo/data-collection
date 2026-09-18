# Red-Team: Phase 10 控制台场景化（总览/研究工作台/衔接/导出，按已接受 demo）

## Top Kill-Assumptions（排序）

1. **Claim：现有后端数据形态足以渲染 demo 里的「证据表」。**
   **Fails if：** 报告是自由 Markdown，UI 只能整段展示；证据表（等级/来源/内容三列）需要结构化证据数据，而 artifacts 现在没有。
   **证据（本周可得）：** 检查 job#4/#5 报告结构——证据行是文本内嵌。→ 成立，缺口真实。
   **Kill criterion：** 若只能脆弱地正则解析 Markdown 呈现证据，放弃证据表改为报告内锚点跳转。
   **最便宜测试：** 在 executor 里解析 research 节点输出为结构化 evidence（`[编号]…【等级 X】…来源：URL` 行式正则），写入 artifacts.meta，前端读 meta。

2. **Claim：UI 能实时展示研究进行中状态（demo 的 4/6 节点链）。**
   **Fails if：** node_state 只在一次 run 结束（成功/暂停）才落库——研究跑 10 分钟里 UI 只看到 running。
   **Kill criterion：** 退化为「running→最终态」两帧展示 + 手动刷新。
   **最便宜测试：** 引擎加 onNode 回调、executor 每节点完成即 `UPDATE job_runs.node_state`。

3. **Claim：MiniMax 配额窗口足以完成端到端研究并接受 live 验证节奏。**
   已部分证伪→修正：job#4 单次 109.7k 跑通成立；同日多轮 429 也成立。**Fails if：** 开发 Phase 10 期间窗口持续关闭，live 验收被阻塞。
   **Kill criterion：** 不阻塞——UI 用种子/历史数据（job#4 报告）验收渲染路径，实时跑通留给闸门复核。

4. **Claim：单 Web 进程写 jobs + 守护进程写 job_runs 双进程写 SQLite 安全。**
   基本成立（WAL + 短时锁；现状 sources 已是双进程写）。**Fails if：** 并发确认/续跑撞上 tick 写入 → SQLITE_BUSY 冒泡。
   **最便宜测试：** busy_timeout 提至 5s + 写操作 catch-busy 重试一次（小改动进 PRD）。

## What's Well-Reasoned

- 无框架 vanilla JS + 服务端渲染 JSON：现有控制台同模式已承载 6 页无压力；
- 端点先行（T9.5 已铺 templates/create/confirm/jobs/:id）：Phase 10 主要是读端点+补两个数据面（meta 证据、增量快照）；
- 导出扩展（report md / dataset csv）复用现有 export 通道，风险低；
- 对话衔接是前端意图路由，不动 planner 契约。

## 无法评估

- Phase 10 完成后的真实运营体验（待用户试用反馈，非本 red-team 范畴）。

## Verdict：**GO**（缺口 1/2 属实现细节，纳入 PRD 作为显式需求）
