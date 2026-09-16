# 智能数据采集与结构化工具

自适应、低维护成本、供应商可替换的网页采集与结构化提取工具：自有抓取层（httpx + trafilatura，可选 Playwright）+ LLM API 语义提取（Provider 抽象），产出 Pydantic 强类型数据落库 SQLite，全程台账可追溯。

> 架构设计、数据契约与各阶段验收标准见 [PLAN.md](PLAN.md)；任务进度见 [TASKS.md](TASKS.md)。

## 核心特性

- **抗改版语义抓取**：LLM 理解正文语义提炼字段，DOM 改版不影响抽取稳定性
- **供应商可替换**：Gemini / Anthropic 协议（MiniMax 等）/ OpenAI 协议（DeepSeek、OpenRouter、Ollama 等），改配置即切换，主供应商故障自动降级
- **成本可控**：提取前去重（内容未变 0 次 LLM 调用）、令牌桶限速、日预算熔断
- **可追溯证据链**：SHA-256 原始快照 + `crawl_runs` 运行台账（六种终态全量记录）
- **轻量部署**：纯 Python + SQLite，无常驻外部依赖

## 从零到运行（约 10 分钟）

### 1. 安装

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

可选扩展：

```bash
pip install -r requirements-ui.txt                          # Web 监控面板
pip install playwright && playwright install chromium       # JS 渲染站点支持
```

### 2. 配置 API Key

在 [Google AI Studio](https://aistudio.google.com/apikey)（免费）、[MiniMax 开放平台](https://platform.minimax.cn) 或 [DeepSeek](https://platform.deepseek.com) 申请 Key，然后：

```bash
cp .env.example .env    # 编辑 .env 填入至少一个 Key
```

`.env` 已被 `.gitignore` 排除，**严禁提交到仓库**。

### 3. 首次采集

```bash
# 单次采集（任意有正文页面的公开网页）
python scripts/run_once.py --url "https://en.wikipedia.org/wiki/Web_scraping"

# JS 渲染站点（需已安装 playwright）
python scripts/run_once.py --url "https://quotes.toscrape.com/js/" --browser
```

输出 JSON 包含 `status`、Token 用量与结构化 `item`。退出码：0 成功/跳过，1 任务失败，2 配置错误。

### 4. 常驻采集

```bash
python scripts/import_sources.py     # sources.yaml → sources 表（幂等，可重复执行）
python scripts/run_daemon.py         # 守护进程：每 30s 扫描来源表，按 interval_s 调度
```

来源的新增/启停/改间隔可编辑 `sources.yaml` 后重新 `import_sources.py`，或直接在面板「来源管理」页操作，**下一个 tick（30s）内生效，无需重启**。Ctrl-C 优雅退出（排干在途任务）。

### 5. 查看数据

```bash
python scripts/export_data.py --format json --since 2026-09-16   # 导出 JSON
python scripts/export_data.py --format csv --out out.csv         # 导出 CSV（Excel 友好）
streamlit run scripts/dashboard.py                               # Web 监控面板
```

## 配置指南

### `config/settings.yaml`

| 段 | 说明 |
| :--- | :--- |
| `provider.primary` / `provider.fallback` | 主/备供应商名；主退避穷尽（429/5xx×5 次）自动切换 |
| `provider.<name>.rpm` | 主动限速（次/分钟），按供应商配额保守设置 |
| `provider.openai-compat.response_format` | `json_schema`（默认）/ `json_object` / `none`，适配端点对结构化输出的支持差异 |
| `budget` | 日预算双上限（任务数 / input tokens），超限当日停止派发 |
| `scheduler.tick_s` | 守护进程扫描 sources 表的周期 |
| `fetch` | UA、robots 合规开关、同域名最小请求间隔 |
| `alerts.macos_notify` | BLOCKED / 认证失败时是否发 macOS 通知 |

### 采集来源（sources 表）

字段：`url`、`name`、`schema_type`（`models/registry.py` 注册的类名：`NewsItem` / `CompetitorEvent`）、`interval_s`（≥ 60）、`enabled`、`use_browser`（JS 站点开关）、`instruction`（附加提取指令）。初始模板见 `config/sources.yaml`。

### 自定义提取 Schema

在 `models/` 新建 Pydantic 模型（字段写中文 `description`，作为 LLM 提取的语义提示），并在 `models/registry.py` 注册——面板下拉与校验自动生效。

## 数据与运维

SQLite 库位于 `data/collector.db`，三张核心表：

```sql
-- 运行台账：每次采集的终态（成功/失败/跳过原因全量记录）
SELECT status, COUNT(*) FROM crawl_runs GROUP BY status;
-- Token 监控：按天统计（仅计消耗 LLM 的任务）
SELECT substr(created_at,1,10) d, SUM(input_tokens), SUM(output_tokens)
FROM crawl_runs WHERE status IN ('SUCCESS','SCHEMA_ERROR') GROUP BY d;
-- 查某 URL 的全部历史
SELECT * FROM crawl_runs WHERE url LIKE '%en.wikipedia.org%' ORDER BY id DESC;
```

- 原始正文快照：`data/raw/{sha256}.md`（内容寻址，天然去重）
- 预算调整：改 `settings.yaml` 的 `budget` 后重启守护进程
- 写入约定：SQLite 单 Worker 串行写；面板读路径为 `mode=ro` 只读连接，与采集并发不冲突

## 常见故障排查

| 现象 | 原因与处理 |
| :--- | :--- |
| `SKIPPED_UNCHANGED` | 内容与上次一致，去重闸门跳过（0 成本，正常行为） |
| `SKIPPED_NO_CONTENT` | 页面无正文（列表页/聚合页）；`run_once` 加 `--browser` 或来源设 `use_browser: true` 再试 |
| `BLOCKED`（403/429） | 目标站风控或 robots 拒绝。确认 UA 合规；robots 不允许则该站不可采 |
| `FETCH_ERROR` | 网络超时、5xx 或页面 404；看 `crawl_runs.error_msg` |
| `SCHEMA_ERROR` | 两次提取均未通过校验；查看 `error_msg` 中的模型原始输出片段 |
| 429 频繁 | 自动指数退避（2s→32s）已内置；持续出现则调低 `rpm` 或等待配额刷新 |
| 主供应商不可用 | 自动切换 fallback，`crawl_runs.provider` 可见实际通道 |
| `API key not valid` | `.env` 的 Key 无效或未生效；修正后重启进程 |
| MiniMax 的 input_tokens 显示 1 | 该端点上报不准（已知问题）；预算以任务数上限为主防线 |

## 开发与测试

```bash
scripts/check.sh                 # 一键：装依赖 + 全量测试 + 覆盖率报告
pytest                           # 全量测试（默认跳过 live 用例）
pytest -m live                   # 真实 API 冒烟（需 .env 中配置 Key）
pytest --cov=core --cov=storage  # 覆盖率
```

核心模块语句覆盖 ≥ 80%；live 用例对真实外部服务（网络 / LLM API）做冒烟，无 Key 时自动跳过。

## 硬性约束（开发必读）

- Provider SDK 只允许出现在 `core/providers/` 内，其余代码只依赖 `LLMProvider` 协议
- 凭证只从环境变量 / `.env` 读取
- 对目标站点的任何 HTTP 请求必须经过 `Fetcher`（robots 检查 + 限速）
- SQLite 单 Worker 串行写入；每个任务的终态必须写入 `crawl_runs` 台账
