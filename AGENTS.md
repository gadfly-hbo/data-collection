# AGENTS.md

智能数据采集与结构化工具（TypeScript 版）：自有抓取层（fetch + Readability/turndown，可选 Playwright）+ LLM 语义提取（基于 pi-ai 统一供应商目录，MiniMax-CN 为主通道），产出 zod 强类型数据落库 SQLite；Web 控制台内嵌 pi SDK 提供对话式需求收集与来源发现（MiniMax web_search MCP）。

## 开工前

- 改 `src/` 下任何模块前，先读 [PLAN.md](PLAN.md)——架构分层、数据契约与各阶段验收标准的唯一事实源。
- 领任务前先看 [TASKS.md](TASKS.md)——按依赖顺序执行，完成任务后勾选并连同代码、测试一起提交；阶段验收标准是进入下一阶段的闸门。

## 命令

- 环境安装：`npm install`（Node ≥22.5，建议 24+；Node 直跑 .ts，无构建步骤）
- 单次采集：`npm run run-once -- --url <url>`（`--browser` 走 playwright 渲染）
- 守护进程：`npm run import-sources && npm run run-daemon -- --log-file data/daemon.log`（sources 表驱动，tick 每 30s）
- Web 控制台：`npm run webapp`（独立 HTML 前端，内置调度，自动开浏览器；**与 run-daemon 二选一**）
- 导出数据：`npm run export -- --format json`（csv / markdown 可选）
- 一键检查：`npm run typecheck && npm test`（tsc 严格检查 + vitest 全量）
- 测试：`npx vitest run`（live 用例在 `tests/live/`，需 `.env` 中的 Key 时手动运行 `npx vitest run tests/live`）
- 双端同步：`scripts/sync_peer.sh`（push + 对端 SSH `pull --ff-only`；mini↔MacBook，改动后必跑）

## 硬性规则

- LLM SDK（`@earendil-works/pi-ai`）只允许出现在 `src/providers/`；`@earendil-works/pi-coding-agent`（发现 Agent）只允许出现在 `src/discovery/`；其余代码只依赖 `LlmProvider` 协议与 `DiscoverySession` 接口——这是供应商可替换性的边界，违反即架构回退。豁免：`scripts/probe-*.ts` 一次性诊断脚本（不进产品链路）。
- 凭证只从环境变量 / `.env` 读取（`MINIMAX_API_KEY` 等）。代码里不得内联；`src/providers/piAiProvider.ts` 的 `ENV_FALLBACKS` 是本项与 pi-ai 环境变量约定（`MINIMAX_CN_API_KEY`）之间唯一的桥接点。
- 对目标站点的任何 HTTP 请求必须经过 `Fetcher`（robots 检查 + 域名限速）；仅 `src/connectors/` 中显式声明 `api: true` 的官方 API 端点可走 Fetcher 的 API 通道（保留限速，robots 不适用），网页路径不得豁免。发现 Agent 的检索走 MiniMax MCP（`minimax_web_search`），不直接抓取目标站。
- SQLite 只允许单 Worker 串行写入（`Database` 单连接复用；`run-daemon` 与 `webapp` 的二选一约束由此而来），不引入并发写路径。
- 每个采集任务的终态（含 SKIPPED_* 与异常）必须写入 `crawl_runs` 台账——没有记台账的任务等于没跑。

## 约定

- Node 22.5+ / TypeScript（`node` 直接执行 .ts，import 用 `.ts` 扩展名；类型检查 `tsc --noEmit`）；I/O 一律 async；数据模型用 zod（`src/models/`）。
- 抓取与提取永远分离：先落 SHA-256 快照、过去重闸门，再花 LLM 调用——顺序不可颠倒。
- 状态机取值以 PLAN.md §5.5 为准（SUCCESS / FETCH_ERROR / BLOCKED / SKIPPED_UNCHANGED / SKIPPED_NO_CONTENT / SCHEMA_ERROR，见 `src/status.ts`），不新造同义词。
- 发现 Agent 只产出「候选来源」，必须经用户确认才写入 `sources` 表并调度——执行确认边界不可绕过。
- UI 遵循 JuanerAI Prism 棱镜设计规范（全局 `~/.zcode/design/DESIGN.md`）：侧边栏外壳、墨青主色、语义色徽标配文字、每页固定结构。
