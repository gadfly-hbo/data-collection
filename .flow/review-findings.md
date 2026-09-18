# Review Findings（fixed point 94591c6，Phase 10）

## Blocking（cycle 1 修复清单）
1. [Spec-a1] web/style.css 未移植 demo 的 node-chain/spectrum/scenario-grid/badge-teal/badge-brand → 节点链无呼吸态、证据三色缺二、场景卡裸奔（story 4/5/16）
2. [Std-3] engine onNode 在节点 try 内：快照 UPDATE 抛错会致已完成 LLM 节点整体重跑（双份 token）；gate-skip 回调在 try 外 throw 会把 paused 变 FAILED → 快照写失败必须不致命
3. [Std-2/Spec-a4] webapp researchActivate 的 setJobEnabled 未包 retryOnBusy
4. [Std-1/Spec-c] overview：`今日失败 ${"?"} 次` 占位符；badSources 未取 fails 列
5. [Std-7/Spec-b] pendingConfirm 用 enabled=0 会把「已删除停用」的研究误计为待确认 → 条件加「无 job_runs」
6. [Spec-a5] /api/export/dataset/:jobId 无 UI 入口（app.js 替换未命中，CSV 按钮实际未插入）
7. [Spec-a2] 报告缺口 notice 无「续跑补证」按钮（story 7）
8. [Spec-c] chat 研究草稿卡文案「预算默认 25 万」与实际默认 400k 不符 → chat 创建显式传 max_input_tokens=250000
9. [Spec-a3] 首节点完成前 node_state 为 null → 节点链整体不渲染：executor 开跑即写初始快照 + 端点以模板节点为骨架补 pending
10. [Std-rCount] overview rCount 死代码删除
11. [Spec-a?] 同屏双 btn-primary（研究页）→ 详情「确认并开始」降级 secondary（Prism 单主按钮）

## Non-blocking（记录不修）
- escCell 与 export-data.ts 内部 esc 重复；window.go 两段 monkey-patch 链脆弱；refreshOverview && 永真守卫；dataset 无 LIMIT；CSV 未防公式注入（下轮加）


## cycle1 修复结果（2026-09-18）
11 项 blocking 全部处理：CSS 自 demo 移植；onNode try 包裹+初快照先落库+端点模板骨架；confirm/resume 包 retry；rCount 删；badSources fails 实值；pendingConfirm 排除已删任务；dataset CSV 入口（预览旁）；缺口续跑补证按钮；chat 草稿预算文案与传参一致 25 万；确认按钮降 secondary（单主按钮）。123 测试绿。
