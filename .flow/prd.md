# PRD: Phase 10 — 控制台场景化（总览 · 研究工作台 · 衔接 · 导出）

> 无 issue tracker（项目未配置）→ 按 dev-flow 约定落 `.flow/prd.md`。
> 上游依据：已接受的 web/demo.html 静态稿、PLAN §11、red-team（.flow/red-team.md）。

## Problem Statement

深度研究的机制与 API 已就绪，但非技术运营用户没有任何界面能发起研究、看进度、读报告；三类采集任务（研究/定制/临时）散落在三个入口，没有「打开就知道去哪、下一步做什么」的统一视图；报告只有 Markdown 原文，没有 demo 承诺的证据表与数据缺口视图；研究与临时采集之间没有衔接。

## Solution

把 demo 稿落成真实控制台：新增「总览」首页（三场景卡+指标+待办）与「研究工作台」（发起表单、任务列表、节点链执行视图、报告预览+证据表+缺口、确认/续跑按钮）；对话助手识别研究意图并引导创建草稿；导出扩展支持研究报告与 dataset。底层补两个数据面：节点增量快照（实时进度）与结构化证据（meta.evidence），并加固双进程写的 BUSY 容错。

## User Stories

1. 作为运营，我打开控制台第一眼能看到今天跑了什么、有什么要我处理，以便决定下一步。
2. 作为运营，我想在研究工作台选类型（商圈/品牌/企业）填对象发起研究，以便无需命令行。
3. 作为运营，发起研究后我想要先看计划再确认执行，以便控制 token 消耗。
4. 作为运营，我想在任务详情看到节点链（已完成✓/进行中●/未达/失败），以便掌握研究进展。
5. 作为运营，研究进行中我想每隔几秒自动看到节点状态变化，而不用手动刷新。
6. 作为运营，报告完成后我想看到渲染好的报告正文 + 证据表（编号/等级/来源链接），以便快速核证。
7. 作为运营，报告有数据缺口时我想看到醒目的缺口提示与「续跑补证」按钮，以便一键继续。
8. 作为运营，研究被暂停（配额/校验未达标）时我想看到原因文案与「重新续跑」按钮，以便恢复后一键继续。
9. 作为运营，我想把研究报告导出为 Markdown、把时序数据导出为 CSV，以便分享入库。
10. 作为运营，在对话助手里说「帮我深入研究 X」时，助手应识别为研究需求并生成任务草稿引导到工作台，以便对话与工作台衔接。
11. 作为运营，总览的待办（待补证 N / 失败源 N）应能直达对应页面处理，以便不遗漏。
12. 作为管理员，我想停用/删除定制数据任务而不影响历史台账，以便清理配置。
13. 作为管理员，并发操作（我在网页确认研究、daemon 正在写台账）不应导致报错，以便两边稳定。
14. 作为开发者，节点完成即持久化快照，以便崩溃后续跑损失最小。
15. 作为开发者，证据解析失败时报告页降级为纯 Markdown 展示，以便数据面缺失不白屏。
16. 作为运营，界面遵循 Prism 规范（侧边栏、墨青主操作、语义徽标配文字），以便与整体产品一致。

## Implementation Decisions

- **前端**：沿用无构建 vanilla（index.html 三件套）。新 nav 两组：工作台 = 总览/研究工作台/对话助手/数据源/运行记录/导出（总览与研究置顶）。页面结构与组件严格照 demo（spectrum 进度条、node-chain、证据表 badge、plan-card 复用）。
- **数据面 A（增量快照）**：引擎支持 `onNode(nodeId, state)` 回调；ResearchExecutor 注入回调即时 `UPDATE job_runs SET node_state=...`（当前 running 行）。
- **数据面 B（结构化证据）**：executor 完成后用行级正则从 research/fix 输出提取 `证据编号/等级/来源 URL/内容` 入 artifacts.meta.evidence；前端读 meta 渲染证据表，缺失则降级。
- **API**：扩展 `GET /api/research/jobs/:id`（返回 job+runs+nodes 摘要+report+evidence）；`POST /api/research/:id/confirm|resume` 已有，工作台直接调；新增 `GET /api/export/report/:artifactId`（.md 下载）与 `GET /api/export/dataset/:jobId`（.csv，复用 export 行→CSV）。
- **对话衔接**：`/api/chat` 的 PlanReply 增可选 `intent: "research"`（planner 系统提示词更新）；前端见此标记渲染研究草稿卡→一键 POST /api/research。
- **总览**：聚合现有端点（summary、jobs by type、blocked sources、paused research），无需新后端；待办跳转用前端路由。
- **并发加固**：Database 构造加 `busy_timeout=5000`；webapp 写端点包一次 BUSY 重试。
- **测试面（seam）**：全部在既有最高 seam——`createApp` HTTP 端点测试（prior art：tests/webapp.test.ts 的 withApp 模式）+ engine/executor 纯函数单测；不新增 seam，不加浏览器 E2E（人工按 demo 验收）。

## Testing Decisions

只测外部行为：端点响应契约（证据数组、节点状态流转、导出文件内容头）、引擎回调触发次数与快照持久化、chat intent 透传；不测 DOM。seam 数量：1（HTTP app）+ 既有纯函数层。

## Out of Scope

品牌/企业模板的 live 报告验证（配额窗口内的运营事项，闸门复核）；统计局 connector（T8.3）；实时推送/WebSocket；暗色主题；多用户/权限；demo 之外的视觉再造。
