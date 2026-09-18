# 智能数据采集与结构化工具

自适应、低维护成本、供应商可替换的网页采集与结构化提取工具（TypeScript 版）：自有抓取层（fetch + Readability/turndown，可选 Playwright）+ LLM API 语义提取（基于 pi-ai 统一供应商目录），产出 zod 强类型数据落库 SQLite；Web 控制台内嵌 pi SDK 提供对话式需求收集与来源发现。

> 架构设计、数据契约与各阶段验收标准见 [PLAN.md](PLAN.md)；任务进度见 [TASKS.md](TASKS.md)；协作规范见 [AGENTS.md](AGENTS.md)。

## 核心特性

- **抗改版语义抓取**：LLM 理解正文语义提炼字段，DOM 改版不影响抽取稳定性
- **供应商可替换**：pi-ai 统一目录接入 MiniMax-CN / Anthropic / Google / OpenAI 等；改 `settings.yaml` 即切换，主通道配额耗尽自动退避降级
- **对话式采集**：Web 控制台默认页是对话助手——自然语言描述需求，助手追问补齐、整理成计划卡片，**经你确认后才创建并执行**
- **来源发现**：发现 Agent（pi SDK 嵌入 + MiniMax `web_search` MCP）检索候选来源，去重过滤后供确认
- **成本可控**：提取前去重（内容未变 0 次 LLM 调用）、令牌桶限速、日预算熔断
- **可追溯证据链**：SHA-256 原始快照 + `crawl_runs` 六终态台账（异常也入账）
- **轻量部署**：Node 直跑 TypeScript，无构建步骤；SQLite 单文件

## 从零到运行

### 1. 安装

```bash
# 需要 Node.js ≥22.5（推荐 24+）
npm install
# 可选：JS 渲染站点支持
npm install -D playwright && npx playwright install chromium
```

### 2. 配置 API Key

在 [MiniMax 开放平台](https://platform.minimax.cn) 获取 Token Plan Key（本项目主通道），然后：

```bash
cp .env.example .env    # 编辑 .env 填入 Key
```

`.env` 已被 `.gitignore` 排除，**严禁提交**。代码会自动把 `MINIMAX_API_KEY` 桥接为 pi-ai 期望的 `MINIMAX_CN_API_KEY`。

### 3. 使用

```bash
npm run webapp                      # Web 控制台（自动开浏览器）——对话助手/采集/来源管理/台账/导出
# 或双击项目根目录的「启动控制台.command」（macOS，非技术用户入口）

npm run run-once -- --url "https://en.wikipedia.org/wiki/Web_scraping"   # 单次采集（CLI）
npm run run-once -- --url <JS渲染站> --browser                            # 浏览器渲染路径

npm run import-sources              # sources.yaml → sources 表（幂等）
npm run run-daemon -- --log-file data/daemon.log   # 常驻守护（tick 每 30s）
```

> **单写约束**：`webapp`（默认内置调度）与 `run-daemon` **二选一**运行；`--no-scheduler` 可关闭 webapp 内调度。

## 配置指南

### `config/settings.yaml`

| 段 | 说明 |
| :--- | :--- |
| `provider.primary` / `fallback` | pi-ai 通道名（`minimax-cn` / `anthropic` / `google` / `openai` / `minimax`） |
| `provider.<name>.model` / `.rpm` | 模型名（须存在于 pi-ai 目录）与主动限速（次/分钟） |
| `budget` | 日预算双上限（任务数 / input tokens），超限当日停止派发 |
| `scheduler.tick_s` | 守护进程扫描 sources 表周期 |
| `fetch` | UA、robots 合规开关、同域名最小请求间隔 |
| `alerts.macos_notify` | BLOCKED / 认证失败时发 macOS 通知 |

### 采集来源（sources 表）

字段：`url`、`name`、`schema_type`（`src/models/schemas.ts` 的 zod 注册类名：`NewsItem` / `CompetitorEvent`）、`interval_s`（≥ 60）、`enabled`、`use_browser`、`instruction`。初始模板 `config/sources.yaml`，经 `import-sources` 入库后以**表为单一事实源**（控制台「来源管理」与对话助手直接读写表，下个 tick 生效）。

### 自定义提取 Schema

在 `src/models/schemas.ts` 新增 zod 模型（字段写中文 `description`）并注册进 `SCHEMA_REGISTRY`——控制台下拉、校验、规划器自动生效。

## 数据与运维

SQLite 库 `data/collector.db`，三张核心表：

```sql
SELECT status, COUNT(*) FROM crawl_runs GROUP BY status;          -- 运行台账
SELECT substr(created_at,1,10) d, SUM(input_tokens), SUM(output_tokens)
FROM crawl_runs WHERE status IN ('SUCCESS','SCHEMA_ERROR') GROUP BY d;  -- Token 监控
SELECT * FROM crawl_runs WHERE url LIKE '%wikipedia%' ORDER BY id DESC; -- 按 URL 查历史
```

- 原始正文快照：`data/raw/{sha256}.md`（内容寻址，天然去重）
- 写入约定：`Database` 单连接全进程复用 + 单 Worker 串行；控制台只读路径与面板 `mode=ro` 并发读互不干扰（WAL）
- 预算调整：改 `settings.yaml` 的 `budget` 后重启进程

## 常见故障排查

| 现象 | 原因与处理 |
| :--- | :--- |
| `SKIPPED_UNCHANGED` | 内容与上次一致，去重闸门跳过（0 成本，正常行为） |
| `SKIPPED_NO_CONTENT` | 页面无正文（列表页/聚合页）；加 `--browser` 或来源设 `use_browser: 1` 再试 |
| `BLOCKED`（403/429） | 目标站风控或 robots 拒绝；robots 不允许则该站不可采 |
| `FETCH_ERROR` + `Provider is not configured: google` | 降级链的备用通道缺 Key：给 `settings.yaml` 里配置的 fallback 通道补 Key，或改 primary/fallback 组合 |
| `429 … Token Plan 用量上限` | MiniMax 配额周期耗尽：内置退避已重试，仍失败会记台账并告警；等待周期刷新或提额 |
| `SCHEMA_ERROR` | 两次提取均未通过校验；`error_msg` 含模型原始输出片段 |
| `MINIMAX_API_KEY` 配了仍报鉴权失败 | 确认 `.env` 在项目根目录；pi-ai 走 `MINIMAX_CN_API_KEY`，代码已自动桥接 |

## 开发与测试

```bash
npm test                     # vitest 全量（live 除外）
npm run typecheck            # tsc --noEmit 严格检查
npx vitest run tests/live    # 真实 API 冒烟（需 .env Key，含 pi SDK+MCP 发现链路）
```

代码结构：`src/`（core：fetcher/parser/pipeline/dedup/budget/rateLimiter/planner；`providers/`：pi-ai 封装与降级限速栈；`storage/`：SQLite/快照/台账/查询；`discovery/`：pi SDK 发现 Agent；`models/`：zod 契约）、`scripts/`（CLI 与 webapp 入口）、`web/`（原生 HTML/JS/CSS 控制台，Prism 规范）、`tests/`。

## 硬性约束（开发必读）

- pi SDK 边界：`@earendil-works/pi-ai` 只在 `src/providers/`，`@earendil-works/pi-coding-agent` 只在 `src/discovery/`
- 凭证只从环境变量 / `.env` 读取
- 对目标站点的任何 HTTP 请求必须经过 `Fetcher`（robots 检查 + 限速）
- SQLite 单 Worker 串行写；每个任务的终态必须写入 `crawl_runs` 台账
- 发现 Agent 只产出候选，执行前需用户确认
