# AGENTS.md

智能数据采集与结构化工具：自有抓取层（httpx + trafilatura）+ LLM API 语义提取（Provider 抽象，默认 Gemini 免费层），产出 Pydantic 强类型数据落库 SQLite。

## 开工前

- 改 `core/` 下任何模块前，先读 [PLAN.md](PLAN.md)——架构分层、数据契约与各阶段验收标准的唯一事实源。
- 领任务前先看 [TASKS.md](TASKS.md)——按依赖顺序执行，完成任务后勾选并连同代码、测试一起提交；阶段验收标准是进入下一阶段的闸门。

## 命令

- 环境安装：`python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`
- 单次采集：`python scripts/run_once.py --url <url>`（`--browser` 走 playwright 渲染）
- 守护进程：`python scripts/import_sources.py && python scripts/run_daemon.py`（sources 表驱动，tick 每 30s）
- Web 控制台：`python scripts/webapp.py`（独立 HTML 前端，内置调度，自动开浏览器；**与 run_daemon 二选一**）
- 导出数据：`python scripts/export_data.py --format json`（csv / markdown 可选）
- 监控面板：`streamlit run scripts/dashboard.py`（需 `pip install -r requirements-ui.txt`）
- 一键检查：`scripts/check.sh`（装依赖 + 测试 + 覆盖率）
- 测试：`pytest`（默认跳过 live 用例；设好 Key 后用 `pytest -m live` 运行真实 API 冒烟）

## 硬性规则

- Provider SDK（`google-genai` / `openai`）只允许出现在 `core/providers/` 内；其余代码只依赖 `LLMProvider` 协议——这是供应商可替换性的边界，违反即架构回退。
- 凭证只从环境变量 / `.env` 读取，出现在代码、配置样例或提交历史中即为事故。
- 对目标站点的任何 HTTP 请求必须经过 `Fetcher`（robots 检查 + 域名限速）；绕过它直接发请求会触发封锁与合规风险。
- SQLite 只允许单 Worker 串行写入，不引入并发写路径。
- 每个采集任务的终态（含 SKIPPED_* 与错误）必须写入 `crawl_runs` 台账——没有记台账的任务等于没跑。

## 约定

- Python 3.10+，I/O 一律 asyncio 异步；数据模型用 Pydantic v2（`model_validate_json` 校验）。
- 抓取与提取永远分离：先落 SHA-256 快照、过去重闸门，再花 LLM 调用——顺序不可颠倒。
- 状态机取值以 PLAN.md §5.5 为准（SUCCESS / FETCH_ERROR / BLOCKED / SKIPPED_UNCHANGED / SKIPPED_NO_CONTENT / SCHEMA_ERROR），不新造同义词。
