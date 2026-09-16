# 开发任务清单（TASKS.md）

> 来源：[PLAN.md](PLAN.md) v2.0 任务化拆解。工作方式见 [AGENTS.md](AGENTS.md)。
>
> **执行规则**：按依赖顺序推进；每个任务完成的标准是其「验收」全部可勾选通过；每完成一个任务，勾选状态、连同代码与测试一起提交；**阶段闸门**（各 Phase 末尾的验收标准）未通过不得开始下一阶段任务。

---

## Phase 1：抓取通道与 MVP 验证（Day 1~2）

### T1.1 工程脚手架
- **内容**：创建 `requirements.txt`（httpx、trafilatura、pydantic>=2.0、apscheduler、google-genai、openai、pytest、pytest-asyncio）；按 PLAN.md §6 建目录骨架（`core/`、`core/providers/`、`models/`、`storage/`、`scripts/`、`tests/`）；`config/settings.yaml` 与 `config/sources.yaml` 骨架（含 PLAN.md §5.1 的示例配置）；`.env.example`；pytest 配置（注册 `live` marker，默认忽略）。
- **依赖**：无。
- **验收**：
  - [x] `pip install -r requirements.txt` 全量安装无错误（Python 3.14.4，见下方提交记录中的版本清单）
  - [x] `pytest` 空跑通过（0 失败，3 项脚手架自检通过）
  - [x] `pytest -m live` 提示无匹配用例而非报错（marker 已注册，3 deselected）

### T1.2 数据模型层
- **内容**：`models/base_schema.py`（公共字段 `source_url`、`scraped_at`）；`models/news_schema.py`、`models/competitor_schema.py` 两个业务 Schema。
- **依赖**：T1.1。
- **验收**：
  - [x] 三个模型的 `model_json_schema()` 均可序列化为合法 JSON Schema（单测断言关键字段存在）
  - [x] 字段带中文 `description`（作为 Structured Output 的语义提示，单测逐字段断言含中文）
- **补充交付**：`models/registry.py`（schema_type 字符串 → 模型类注册表，供 T1.6 解析 sources.yaml 使用）

### T1.3 抓取器 Fetcher
- **内容**：`core/fetcher.py`——`httpx.AsyncClient`（UA、30s 超时、跟随重定向）；robots.txt 检查（按域名缓存，拒绝 → `BLOCKED`）；同域名最小间隔限速；条件请求（`ETag`/`Last-Modified` → 304 短路）；状态分类 `OK / BLOCKED / FETCH_ERROR`。
- **依赖**：T1.1。
- **验收**：
  - [x] 单测：robots 允许/拒绝/不可达三分支（另覆盖 5xx 视为全站禁止）；限速间隔生效（注入 `_sleep` 断言同域第二次请求等待 ≥ 配置值）；403/429/401 归为 `BLOCKED`、超时与 5xx/404 归为 `FETCH_ERROR`；304 短路、重定向跟随
  - [x] live 冒烟：对 `https://news.ycombinator.com` 返回 `OK` 且带 HTML

### T1.4 正文抽取 Parser
- **内容**：`core/parser.py`——`trafilatura.extract(output_format="markdown")` 封装；无正文的列表页/空页返回 `None`（对应 `SKIPPED_NO_CONTENT`）。
- **依赖**：T1.1。
- **验收**：
  - [ ] 单测：正文型 fixture HTML → 非空 Markdown 且剥离导航/评论；空 HTML 与无正文页面 → `None`

### T1.5 LLMProvider 协议与 GeminiProvider
- **内容**：`core/providers/base.py`（`LLMProvider` 协议 + `ExtractionResult`：item、input/output_tokens、provider、model）；`core/providers/gemini.py`（原生 `response_schema` 接受 Pydantic 模型；初始化校验 `GEMINI_API_KEY`；HTTP 429/5xx 归一化为 `TransientProviderError`）。
- **依赖**：T1.1、T1.2。
- **验收**：
  - [ ] 单测（mock SDK）：schema 约束被传入、token 用量被提取、429 归一化异常
  - [ ] live 冒烟：对样例正文 + `news_schema` 返回通过 Pydantic 校验的对象
  - [ ] **记录实测单任务 Token 消耗基线**（写入本文件 Phase 3 参数区）

### T1.6 流水线主干与 run_once
- **内容**：`core/pipeline.py`（fetch → parse → extract → 校验 → 输出；`validate_or_retry_once` 失败后全新调用一次，instruction 附失败原因；快照/去重/台账此阶段先留桩接口）；`scripts/run_once.py`（`--url` 与 `--schema` 参数）。
- **依赖**：T1.3、T1.4、T1.5。
- **验收**：
  - [ ] `run_once.py --url https://news.ycombinator.com` 打印通过 Pydantic 校验的 JSON
  - [ ] 连跑 10 次成功率 ≥ 90%，输出含每次的 input/output tokens
  - [ ] 失败任务给出可读错误而非堆栈崩溃

**阶段闸门 1**：以上全部通过，且 Token 基线数据已记录。此数据用于校准 Phase 3 的 `budget` 参数；若实测消耗换算的日可跑任务数远低于预期（< 100），先回到 PLAN.md §8 复核配额策略再继续。

---

## Phase 2：存储流水线与去重闭环（Day 3~4）

### T2.1 快照存储 raw_store
- **内容**：`storage/raw_store.py`——SHA-256 内容哈希命名写盘（`data/raw/{sha256}.md`）、读取、存在性查询。
- **依赖**：T1.6。
- **验收**：
  - [ ] 单测：同内容两写只落一个文件；读取内容与写入一致；哈希与文件名一致

### T2.2 SQLite 三表 db
- **内容**：`storage/db.py`——按 PLAN.md §5.5 建 `sources` / `crawl_runs` / `extracted_items` 三表 + `schema_version` 元数据表；各表写入接口；单例连接。
- **依赖**：T1.1。
- **验收**：
  - [ ] 建库幂等（重复初始化不报错、不丢数据）
  - [ ] 写入接口的单测覆盖三表（内存 SQLite）

### T2.3 去重闸门 dedup
- **内容**：`core/dedup.py`——URL + 内容哈希联合判断；接入 pipeline（位于快照之后、LLM 之前）；命中记 `SKIPPED_UNCHANGED`。
- **依赖**：T2.1、T2.2。
- **验收**：
  - [ ] 单测：同 URL 同哈希命中；同 URL 新哈希不命中；不同 URL 同哈希不互相干扰
  - [ ] 集成：重复执行同一 URL，第二次走 `SKIPPED_UNCHANGED` 且 **0 次 LLM 调用**（以调用计数断言）

### T2.4 台账全量接入
- **内容**：pipeline 所有终态（含 `FETCH_ERROR / BLOCKED / SKIPPED_UNCHANGED / SKIPPED_NO_CONTENT / SCHEMA_ERROR`）写入 `crawl_runs`，成功路径写 `extracted_items`。
- **依赖**：T2.2、T2.3。
- **验收**：
  - [ ] 六种状态各触发一次的集成测试，`crawl_runs` 各有一行且字段完整（provider、tokens、duration_ms）

**阶段闸门 2**：5 个不同 URL 批量采集全部正确落库；重复执行不产生重复行、不产生重复 LLM 调用。

---

## Phase 3：定时守护、限流退避与降级（Day 5~6）

### T3.1 退避与限流
- **内容**：`core/rate_limiter.py`——`with_backoff`（指数退避 + 随机抖动，上限 300s，重试 5 次）；按 Provider RPM 的令牌桶主动限速。
- **依赖**：T1.5。
- **验收**：
  - [ ] 单测：429 序列的退避间隔符合 2s→4s→8s→16s→32s（mock sleep 断言）；重试穷尽后向上抛出
  - [ ] 令牌桶：超过 RPM 的调用被延迟而非立即发出

### T3.2 供应商降级
- **内容**：主供应商退避穷尽后切换 `fallback`（配置见 settings.yaml），台账记录实际 provider。
- **依赖**：T3.1、（T4.2 的 openai_compat 可用 fake provider 替身先行开发）。
- **验收**：
  - [ ] 集成：主供应商持续失败 → 任务由 fallback 完成且 `crawl_runs.provider` 记录为 fallback

### T3.3 日预算熔断
- **内容**：`budget` 双上限（`max_tasks_per_day`、`max_input_tokens_per_day`，按 T1.5 实测基线校准参数）；超限后当日停止派发新任务。
- **依赖**：T2.4。
- **验收**：
  - [ ] 单测：伪造台账数据逼近/超过上限，新任务被拒并有明确日志

### T3.4 守护进程 run_daemon
- **内容**：`scripts/run_daemon.py`——APScheduler 按 `sources.yaml` 的 `interval_s` 调度；串行 Worker；优雅退出（SIGINT/SIGTERM 排干队列）；告警最小出口（`blocked` 与认证失败 → ERROR 日志 + 可选 macOS 本地通知）。
- **依赖**：T2.4、T3.1、T3.3。
- **验收**：
  - [ ] 按 `sources.yaml` 配置的两个来源各自按间隔触发
  - [ ] Ctrl-C 后无半写状态、无残留协程

**阶段闸门 3**：守护进程连续 24 小时稳定运行（无任务丢失、无未记台账任务）；人为注入 429 可观测到退避与恢复；主供应商不可用时自动降级。

---

## Phase 4：扩展能力与生产封装（Day 7~8）

### T4.1 导出工具
- **内容**：`scripts/export_data.py`——`--format csv/json/markdown`、按 schema_type/日期过滤。
- **依赖**：T2.4。
- **验收**：
  - [ ] 三种格式导出的行数与库内一致；CSV 中文无乱码；JSON 可被 `model_validate_json` 反向校验

### T4.2 OpenAICompatProvider
- **内容**：`core/providers/openai_compat.py`（`base_url` + `api_key_env` 配置注入；`json_schema` strict 模式；同样的异常归一化）；配置切换验证。
- **依赖**：T1.5。
- **验收**：
  - [ ] live 冒烟：对同一正文分别用 gemini 与 openai-compat 提取，均通过校验
  - [ ] 仅改 `settings.yaml` 的 `primary` 字段即可切换，代码零改动

### T4.3 Playwright Fetcher（可选）
- **内容**：`core/fetcher.py` 增加 `use_browser` 路径（按 sources.yaml 站点级开关）；浏览器实例复用与超时。
- **依赖**：T1.3。
- **验收**：
  - [ ] live 冒烟：对一个强 JS 渲染站点静态抓取为空、浏览器路径拿到正文
  - [ ] 未启用浏览器路径的站点行为与 T1.3 完全一致（回归通过）

### T4.4 测试补齐
- **内容**：补齐 `tests/` 对 core/ 与 storage/ 的覆盖；README 的故障排查段落对应每类可注入错误有测试复现。
- **依赖**：T4.1、T4.2。
- **验收**：
  - [ ] `pytest`（不含 live）核心模块语句覆盖 ≥ 80%
  - [ ] CI 可一键运行（即使暂只本地脚本）

### T4.5 README
- **内容**：从零到运行（Key 申请、安装、配置、启动）、sources.yaml 配置指南、常见故障（429/403/Key 无效/SKIPPED 含义）、运维（台账查询、Token 监控、预算调整）。
- **依赖**：全部。
- **验收**：
  - [ ] 新环境按 README 操作可在 15 分钟内跑通 `run_once`
  - [ ] PLAN.md §7 Phase 4 验收标准全部满足：一键安装运行、仅改配置切换供应商

---

## 参数记录区（任务执行中回填）

| 指标 | 实测值 | 记录任务 |
| :--- | :--- | :--- |
| 单任务 input tokens（均值） | 待测 | T1.5 |
| 单任务 output tokens（均值） | 待测 | T1.5 |
| 单任务端到端耗时（均值） | 待测 | T1.6 |
| 免费层实测日可支撑任务数 | 待推算 | 阶段闸门 1 |
| `budget.max_tasks_per_day` 定值 | 待定 | T3.3 |
| `budget.max_input_tokens_per_day` 定值 | 待定 | T3.3 |
