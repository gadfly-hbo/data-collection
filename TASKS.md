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
  - [x] 单测：正文型 fixture HTML → 非空 Markdown 且剥离导航/评论；空 HTML 与无正文页面 → `None`（采用 `favor_precision` 高精度模式实现列表页识别）

### T1.5 LLMProvider 协议与 GeminiProvider
- **内容**：`core/providers/base.py`（`LLMProvider` 协议 + `ExtractionResult`：item、input/output_tokens、provider、model）；`core/providers/gemini.py`（原生 `response_schema` 接受 Pydantic 模型；初始化校验 `GEMINI_API_KEY`；HTTP 429/5xx 归一化为 `TransientProviderError`）。
- **依赖**：T1.1、T1.2。
- **验收**：
  - [x] 单测（mock SDK）：schema 约束被传入、token 用量被提取、429/5xx 归一化异常；另覆盖鉴权错误不误判瞬态、空响应、非法 JSON 抛 ValidationError、缺 Key 拒绝初始化（gemini 与 anthropic-compat 各一套）
  - [x] live 冒烟：对样例正文 + `news_schema` 返回通过 Pydantic 校验的对象（按决议改为"任一已配 Key 的兼容端点"——实测经 `anthropic-compat` / MiniMax-M3 连续两次通过；Gemini 待有 Key 后由同一用例自动覆盖）
  - [x] **记录实测单任务 Token 消耗基线**（写入下方参数记录区）
- **补充交付**：`core/providers/anthropic_compat.py`（Anthropic 协议端点，覆盖 MiniMax，自 Prompt 注入 Schema + JSON 提取 + Pydantic 兜底）、`core/providers/factory.py`（配置 → 实例）、`core/dotenv.py`（.env 加载，conftest 已接入）；live 冒烟用例按 settings.yaml 自动选择有 Key 的供应商

### T1.6 流水线主干与 run_once
- **内容**：`core/pipeline.py`（fetch → parse → extract → 校验 → 输出；`validate_or_retry_once` 失败后全新调用一次，instruction 附失败原因；快照/去重/台账此阶段先留桩接口）；`scripts/run_once.py`（`--url` 与 `--schema` 参数）。
- **依赖**：T1.3、T1.4、T1.5。
- **验收**：
  - [x] `run_once.py --url <有正文页面>` 打印通过 Pydantic 校验的 JSON（目标页修订：HN 首页经实测为聚合列表页，被解析层按设计判为 `SKIPPED_NO_CONTENT`——T1.4 高精度模式的预期行为、PLAN §10 两段式采集的目标场景；端对端验收目标改为 `https://en.wikipedia.org/wiki/Web_scraping`，HN 首页保留为 SKIPPED 负样本并验证通过、0 次 LLM 调用）
  - [x] 连跑 10 次成功率 ≥ 90%，输出含每次的 input/output tokens（实测 10/10，数据见参数记录区）
  - [x] 失败任务给出可读错误而非堆栈崩溃（供应商异常与配置错误均输出 JSON error 字段，退出码区分 0/1/2）

**阶段闸门 1**：✅ 已通过（2026-09-16）——Phase 1 全部任务验收通过，Token 基线已记录。基线结论：单任务 output ≈ 242 tokens（227~264）；MiniMax 端点的 `usage.input_tokens` 在 10 次真实运行中 9 次报 1、仅 1 次报真实值（≈6.7k，与页面字符数吻合），**T3.3 预算熔断不能依赖该端点的 input 上报**，应按任务数 + 内容长度估算（chars/4）设计。MiniMax 通道暂无免费层日限额约束；后续接入 Gemini 免费层时按其 RPD 复核日可跑任务数。

---

## Phase 2：存储流水线与去重闭环（Day 3~4）

### T2.1 快照存储 raw_store
- **内容**：`storage/raw_store.py`——SHA-256 内容哈希命名写盘（`data/raw/{sha256}.md`）、读取、存在性查询。
- **依赖**：T1.6。
- **验收**：
  - [x] 单测：同内容两写只落一个文件；读取内容与写入一致；哈希与文件名一致

### T2.2 SQLite 三表 db
- **内容**：`storage/db.py`——按 PLAN.md §5.5 建 `sources` / `crawl_runs` / `extracted_items` 三表 + `schema_version` 元数据表；各表写入接口；单例连接。
- **依赖**：T1.1。
- **验收**：
  - [x] 建库幂等（重复初始化不报错、不丢数据）
  - [x] 写入接口的单测覆盖三表（内存 SQLite，含外键强制、dedup_hash 唯一忽略、未来版本拒绝打开）
- **补充交付**：`core/status.py`（RunStatus 独立模块，避免 dedup→pipeline 循环导入）；PLAN §5.5 修订——crawl_runs 补 `url` 列（ad-hoc 任务不经过 sources，url 必随行）

### T2.3 去重闸门 dedup
- **内容**：`core/dedup.py`——URL + 内容哈希联合判断；接入 pipeline（位于快照之后、LLM 之前）；命中记 `SKIPPED_UNCHANGED`。
- **依赖**：T2.1、T2.2。
- **验收**：
  - [x] 单测：同 URL 同哈希命中；同 URL 新哈希不命中；不同 URL 同哈希不互相干扰（另覆盖：此前失败记录不命中——内容未变也应重试提取）
  - [x] 集成：重复执行同一 URL，第二次走 `SKIPPED_UNCHANGED` 且 **0 次 LLM 调用**（以调用计数断言；注：闸门依赖台账中的 SUCCESS 行，T2.4 接线后闭环）

### T2.4 台账全量接入
- **内容**：pipeline 所有终态（含 `FETCH_ERROR / BLOCKED / SKIPPED_UNCHANGED / SKIPPED_NO_CONTENT / SCHEMA_ERROR`）写入 `crawl_runs`，成功路径写 `extracted_items`。
- **依赖**：T2.2、T2.3。
- **验收**：
  - [x] 六种状态各触发一次的集成测试，`crawl_runs` 各有一行且字段完整（provider、tokens、duration_ms；SUCCESS 额外写 extracted_items 且内容去重哈希排除 scraped_at/source_url 易变字段）

**阶段闸门 2**：✅ 已通过（2026-09-16）——5 个 Wikipedia 词条真实采集全部 SUCCESS 落库（crawl_runs 5 行、extracted_items 5 行、快照 5 个）；复跑 Web_scraping → `SKIPPED_UNCHANGED`、0 token、raw_hash 与首跑一致、无重复行无重复 LLM 调用。实测 input tokens 随页面体量 6.6k~28k 浮动（Machine_learning 词条最大）。

---

## Phase 3：定时守护、限流退避与降级（Day 5~6）

### T3.1 退避与限流
- **内容**：`core/rate_limiter.py`——`with_backoff`（指数退避 + 随机抖动，上限 300s，重试 5 次）；按 Provider RPM 的令牌桶主动限速。
- **依赖**：T1.5。
- **验收**：
  - [x] 单测：429 序列的退避间隔符合 2s→4s→8s→16s→32s（注入 sleep 确定性断言）；重试穷尽后向上抛出（另覆盖抖动上界与非瞬态错误立即传播）
  - [x] 令牌桶：超过 RPM 的调用被延迟而非立即发出（注入时钟断言等待时长）

### T3.2 供应商降级
- **内容**：主供应商退避穷尽后切换 `fallback`（配置见 settings.yaml），台账记录实际 provider。实际交付为 `FallbackProvider` + `create_provider_stack`（primary→fallback 取可用者 + 按 effective 主供应商 RPM 令牌桶限速），替代原 openai_compat 替身方案。
- **依赖**：T3.1、（原定 T4.2 openai_compat 替身——实际以 anthropic-compat 为备用通道）。
- **验收**：
  - [x] 集成：主供应商持续失败 → 任务由 fallback 完成且 `crawl_runs.provider` 记录为 fallback

### T3.3 日预算熔断
- **内容**：`budget` 双上限（`max_tasks_per_day`、`max_input_tokens_per_day`，按 T1.5 实测基线校准参数）；超限后当日停止派发新任务。
- **依赖**：T2.4。
- **验收**：
  - [x] 单测：伪造台账数据逼近/超过上限，新任务被拒并有明确日志（run_once 输出可读错误退出码 2；daemon 派发前检查 + WARNING 日志跳过）

### T3.4 守护进程 run_daemon
- **内容**：`scripts/run_daemon.py`——APScheduler 按 `sources.yaml` 的 `interval_s` 调度；串行 Worker；优雅退出（SIGINT/SIGTERM 排干队列）；告警最小出口（`blocked` 与认证失败 → ERROR 日志 + 可选 macOS 本地通知）。
- **依赖**：T2.4、T3.1、T3.3。
- **验收**：
  - [x] 按 `sources.yaml` 配置的两个来源各自按间隔触发（冒烟实测：3600s/7200s 错峰首跑，台账各记一行且含 source_id，来源已 upsert 进 sources 表）
  - [x] Ctrl-C 后无半写状态、无残留协程（SIGINT → `scheduler.shutdown(wait=True)` 排干在途任务后干净退出）

**阶段闸门 3**：⏳ 24h 观测进行中——守护进程已于 **2026-09-16 22:46**（本地时间）启动后台观测（`caffeinate -is` 防睡眠，日志随进程输出），预计 2026-09-17 22:46 后复核回填。其余两项验证已完成：
- 退避与恢复：确定性单测验证（mock 429 序列 2s→4s→8s→16s→32s、穷尽上抛、抖动上界）；真实 429 若发生可在日志与台账观测到退避后恢复
- 供应商降级：集成测试验证（主退避穷尽 → fallback 完成 → `crawl_runs.provider=fallback`）；本机当前仅 anthropic-compat 有 Key，栈直接以可用者为主通道启动
- 预算熔断：run_once 派发前检查（退出码 2）与 daemon 调度跳过均已覆盖
- 复核指标：进程存活、台账行数 = 调度次数（无任务丢失、无未记台账任务）、无未处理异常

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

## Phase 5：Web 管理界面（可选增强，Phase 4 后按需启动）

> 定位：PLAN.md §10 原列为本期范围外的 Web UI，已拆解排期。实现前提：T2.4（有台账数据可看）、T3.4（配置管理需守护进程配合）。UI 依赖独立放 `requirements-ui.txt`，不污染无界面部署；AGENTS.md 硬性规则继续适用——面板对 SQLite 只读（T5.1），配置写路径收敛在来源表（T5.2），不引入并发写台账。

### T5.1 只读监控面板
- **内容**：`scripts/dashboard.py`（Streamlit，SQLite **read-only 连接** `file:...?mode=ro`）三块视图——状态监控（`crawl_runs` 成功率 / 状态分布 / Token 消耗按天趋势 / blocked 来源清单）、数据查询（`extracted_items` 按 schema_type / 日期 / 关键词过滤，详情 JSON 展开）、来源总览（`sources` 与各自最近一次运行状态）；新增 `requirements-ui.txt`（streamlit）。
- **依赖**：T2.4。
- **验收**：
  - [ ] `streamlit run scripts/dashboard.py` 三块视图可用
  - [ ] 只读保证：ro 模式连接 + 代码无任何写路径；daemon 运行中并发读不干扰采集
  - [ ] 查询带日期 / 条数上限分页，万级台账不卡死

### T5.2 来源配置管理
- **内容**：来源白名单从 sources.yaml 迁移为 `sources` 表（单一事实源）：一次性幂等迁移命令 `scripts/import_sources.py`（UNIQUE url 冲突则更新）；面板支持来源新增 / 编辑 / 启停 / 删除（schema_type 下拉限定 registry 注册项、interval_s 校验下限）；`run_daemon` 改为每轮从 `sources` 表读取任务清单。
- **依赖**：T5.1、T3.4。
- **验收**：
  - [ ] 面板新增 / 禁用来源后，daemon 下一轮按新配置执行（被禁用来源不再调度）
  - [ ] sources.yaml → sources 表迁移可重复执行（幂等）
  - [ ] 非法输入被拒：未知 schema_type、interval_s 低于抓取下限、URL 非法

**阶段闸门 5**：daemon 运行 24 小时期间面板持续可用（并发只读不影响采集）；所有配置变更在下一轮调度中生效，且可从台账追溯到对应执行记录。

---

## 参数记录区（任务执行中回填）

| 指标 | 实测值 | 记录任务 |
| :--- | :--- | :--- |
| 单任务 input tokens | ≈6.7k / 2.7 万字符页面（按 chars/4 估算）；⚠️ MiniMax 端点 `usage.input_tokens` 10 次里 9 次报 1，不可用于预算统计 | T1.6 复核 |
| 单任务 output tokens | 242（227~264，10 次真实页面实测区间） | T1.6 复核 |
| 单任务端到端耗时（均值） | 3.7s（2429~6838ms，含抓取+正文抽取+提取） | T1.6 |
| 免费层实测日可支撑任务数 | MiniMax 通道暂无免费层日限额（按 6.7k in + 250 out/任务估算成本）；Gemini 免费层接入后复核 | 阶段闸门 1 |
| 免费层实测日可支撑任务数 | 待推算 | 阶段闸门 1 |
| `budget.max_tasks_per_day` 定值 | 待定 | T3.3 |
| `budget.max_input_tokens_per_day` 定值 | 待定 | T3.3 |
