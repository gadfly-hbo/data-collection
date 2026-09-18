# 任务拆解（tracer-bullet 垂直切片）

> 切片均含端到端（数据面→API→UI→测试）；测试 seam 统一为 `createApp` HTTP 端点 + engine/executor 纯函数（已 GRILL 自答确认）。

- [x] 1. 并发加固（前置微片）
  - **Blocked by**: 无
  - **覆盖故事**: 13
  - Database 构造设 `busy_timeout=5000`；webapp 写端点（sources/jobs/confirm/resume）BUSY 单发重试；测试：并发写不抛 BUSY（两端点交叠请求冒烟）。

- [x] 2. 研究详情数据面 + 工作台节点链视图
  - **Blocked by**: 1
  - **覆盖故事**: 2(列表),4,5,8,14
  - engine `onNode` 回调 → executor 每节点完成即 UPDATE 当前 running job_runs.node_state；`GET /api/research/jobs/:id` 返回 nodes 摘要+last_error；工作台页：任务列表（状态徽标/进度 x/y 节点）+ 详情（spectrum 条+node-chain+暂停原因+续跑按钮，running 时 10s 自动刷新）。测试：假执行器跑 district 模板断言每节点都有持久化快照；端点契约；resume 端点驱动。

- [ ] 3. 结构化证据 + 报告预览 + Markdown 导出
  - **Blocked by**: 2
  - **覆盖故事**: 6,7,9(报告),15
  - executor 完成后从 research/fix 输出行式解析证据数组（编号/等级/URL/内容）写入 artifacts.meta；`GET /api/export/report/:artifactId` .md 下载；详情端点带 evidence；UI 报告页：证据表（等级徽标+可点来源）+ 缺口提示（末段）+ 报告正文；无 evidence 时降级纯 Markdown。测试：解析器夹具（job#4 风格文本）、端点、导出头。

- [ ] 4. 发起与确认闭环（表单 + chat intent 衔接）
  - **Blocked by**: 2
  - **覆盖故事**: 2(发起),3,10
  - 工作台「新建研究」（模板下拉=templates 端点、对象、深度→maxInputTokens 三档、预算提示）→ 创建 pending → 计划卡确认态文案 → confirm；planner PlanReply 增可选 `intent:"research"` + 系统提示词；chat 前端见 intent 渲染草稿卡→一键建任务。测试：chat 透传、创建→确认→enabled、intent 兜底（缺字段旧行为）。

- [ ] 5. 总览页（聚合+待办直达）
  - **Blocked by**: 2,4（jobs by type 需 research 计数语义稳定）
  - **覆盖故事**: 1,11
  - 新端点 `GET /api/overview`：today 指标、三场景计数（research paused→待补证、connector failed 连续≥3→失败源、今日 adhoc 计数）；前端总览页 + 待办 notice 直达路由。测试：种子数据断言各计数。

- [ ] 6. dataset CSV 导出收尾
  - **Blocked by**: 1
  - **覆盖故事**: 9(数据)
  - `GET /api/export/dataset/:jobId`（最新+累计行 → 现有 toCsv 形状）；数据源页 dataset 预览区加下载按钮。测试：端点导出与库内行数一致。

## 闸门 10
种子任务 #2/#3/#4/#5 全绿 + 端点契约测试全绿；tsc/vitest 全绿；人工对照 demo 走一遍三场景路径；job#5（配额窗口内）产出通过质量门的报告并在工作台可读。
