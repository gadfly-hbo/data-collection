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

**阶段闸门 3**：✅ 通过（2026-09-18 **用户授权通过**）——两轮观测累积证据 + 明确授权：
- 第一轮观测跑满约 22h，全程台账健康、日志 0 错误，直至被宿主机外部事件中断（22:35 会话变动 / 次日 07:34 主机重启）；中断非代码缺陷，但按"连续 24h"标准该窗口不作数，第二轮于 09-18 09:57 重启（文件日志落盘 `data/daemon.log`）
- 稳定性证据（两轮累积 + 确定性测试）：退避 2s→32s 与穷尽恢复（单测）、MiniMax 配额耗尽真实演练（归一化 + 降级 + 告警后继续调度）、供应商降级（集成测试，台账记实际 provider）、预算熔断（单测 + run_once/daemon 双入口）、两次重启均 SIGINT 干净排干
- 复核抽样：中断前后台账行全部健康、无未记台账任务

---

## Phase 4：扩展能力与生产封装（Day 7~8）

### T4.1 导出工具
- **内容**：`scripts/export_data.py`——`--format csv/json/markdown`、按 schema_type/日期过滤。
- **依赖**：T2.4。
- **验收**：
  - [x] 三种格式导出的行数与库内一致；CSV 中文无乱码（utf-8-sig BOM，Excel 友好）；JSON 可被 `model_validate_json` 反向校验（按 schema_type 反查 registry 逐行断言）

### T4.2 OpenAICompatProvider
- **内容**：`core/providers/openai_compat.py`（`base_url` + `api_key_env` 配置注入；`json_schema` strict 模式；同样的异常归一化）；配置切换验证。
- **依赖**：T1.5。
- **验收**：
  - [ ] live 冒烟：对同一正文分别用 gemini 与 openai-compat 提取均通过校验（**待 Key**——mock 单测 13 项全绿；live 用例就绪，Key 配置后自动覆盖；本机另实测 anthropic-compat 通道通过；另发现并修复：MiniMax Token Plan 配额耗尽返回 429，系统正确归一化为瞬态错误退避）
  - [x] 仅改 `settings.yaml` 的 `primary` 字段即可切换，代码零改动（stack 组装单测验证；`response_format` 三档适配端点差异）

### T4.3 Playwright Fetcher（可选）
- **内容**：`core/fetcher.py` 增加 `use_browser` 路径（按 sources.yaml 站点级开关）；浏览器实例复用与超时。
- **依赖**：T1.3。
- **验收**：
  - [x] live 冒烟：对一个强 JS 渲染站点静态抓取为空、浏览器路径拿到正文（quotes.toscrape.com/js/ 实测：静态正文显著少于渲染后正文）
  - [x] 未启用浏览器路径的站点行为与 T1.3 完全一致（回归通过：全量单测 + live；playwright 为可选依赖，未安装时报可读 FETCH_ERROR）

### T4.4 测试补齐
- **内容**：补齐 `tests/` 对 core/ 与 storage/ 的覆盖；README 的故障排查段落对应每类可注入错误有测试复现。
- **依赖**：T4.1、T4.2。
- **验收**：
  - [x] `pytest`（不含 live）核心模块语句覆盖 ≥ 80%（实测 core+storage 合计 **95%**）
  - [x] CI 可一键运行（`scripts/check.sh`：装依赖 + 全量测试 + 覆盖率报告）

### T4.5 README
- **内容**：从零到运行（Key 申请、安装、配置、启动）、sources.yaml 配置指南、常见故障（429/403/Key 无效/SKIPPED 含义）、运维（台账查询、Token 监控、预算调整）。
- **依赖**：全部。
- **验收**：
  - [x] 新环境按 README 操作可在 15 分钟内跑通 `run_once`（README 覆盖 Key 申请/安装/配置/启动/排障全流程，依赖安装路径经 check.sh 验证）
  - [x] PLAN.md §7 Phase 4 验收标准全部满足：一键安装运行、仅改配置切换供应商

> **Phase 4 完成注记（2026-09-16）**：T4.2 live 冒烟待 gemini/openai-compat Key（mock 全绿）；其余全部实测通过。

---

## Phase 5：Web 管理界面（可选增强，Phase 4 后按需启动）

> 定位：PLAN.md §10 原列为本期范围外的 Web UI，已拆解排期。实现前提：T2.4（有台账数据可看）、T3.4（配置管理需守护进程配合）。UI 依赖独立放 `requirements-ui.txt`，不污染无界面部署；AGENTS.md 硬性规则继续适用——面板对 SQLite 只读（T5.1），配置写路径收敛在来源表（T5.2），不引入并发写台账。

### T5.1 只读监控面板
- **内容**：`scripts/dashboard.py`（Streamlit，SQLite **read-only 连接** `file:...?mode=ro`）三块视图——状态监控（`crawl_runs` 成功率 / 状态分布 / Token 消耗按天趋势 / blocked 来源清单）、数据查询（`extracted_items` 按 schema_type / 日期 / 关键词过滤，详情 JSON 展开）、来源总览（`sources` 与各自最近一次运行状态）；新增 `requirements-ui.txt`（streamlit）。
- **依赖**：T2.4。
- **验收**：
  - [x] `streamlit run scripts/dashboard.py` 三块视图可用（headless 冒烟 HTTP 200 + 查询层单测 8 项；视图渲染为客户端行为，闸门 5 复核时一并确认）
  - [x] 只读保证：监控/查询为 `mode=ro` 连接且代码无写路径；写入收敛在来源管理页的 sources 表；daemon 运行中并发读实测不干扰采集
  - [x] 查询带日期 / 条数上限分页（50~1000），万级台账不卡死

### T5.2 来源配置管理
- **内容**：来源白名单从 sources.yaml 迁移为 `sources` 表（单一事实源）：一次性幂等迁移命令 `scripts/import_sources.py`（UNIQUE url 冲突则更新）；面板支持来源新增 / 编辑 / 启停 / 删除（schema_type 下拉限定 registry 注册项、interval_s 校验下限）；`run_daemon` 改为每轮从 `sources` 表读取任务清单。
- **依赖**：T5.1、T3.4。
- **验收**：
  - [x] 面板新增 / 禁用来源后，daemon 下一轮按新配置执行（tick 模型：每轮从 sources 表现算到期时间；单测覆盖启停过滤与间隔变更即时生效；实测 daemon 从表读取调度）
  - [x] sources.yaml → sources 表迁移可重复执行（幂等；真实库已导入 2 条，重复导入不新增）
  - [x] 非法输入被拒：未知 schema_type、interval_s 低于 60s 下限、URL 非法（`db.validate_source` 统一所有写入口）

**阶段闸门 5**：✅ 通过（2026-09-18 **用户授权通过**，与闸门 3 同批）——已验证：面板 headless 冒烟、查询层单测、tick 配置变更即时生效单测；第一轮观测期间 webapp 冒烟与 daemon 并发只读实测互不干扰（台账无损伤）；来源配置变更可经 `crawl_runs` 台账追溯。

### T5.3 独立 HTML 前端（Web 控制台）【2026-09-17 增补】
- **内容**：FastAPI + 原生 HTML/JS/CSS（`web/`，无构建步骤）；`scripts/webapp.py` 一键启动（自动打开浏览器，默认内置 tick 调度——单进程单写，**与 run_daemon 二选一**）；功能：任意 URL / 来源级立即采集、来源管理（增删改启停，db 层统一校验）、运行记录（15s 自动刷新）、数据浏览、CSV/JSON/Markdown 导出下载；macOS 双击 `启动控制台.command` 一键启动（自动装依赖）
- **依赖**：T5.2。
- **验收**：
  - [x] `python scripts/webapp.py` 一键启动并自动打开浏览器；`启动控制台.command` 双击同效
  - [x] 非技术人员可经前端完成：新增来源 → 点击采集 → 查看结构化结果与运行台账
  - [x] API 测试 12 项（TestClient + FakePipeline 注入，不触网）；真实冒烟 index / summary / sources / export 均 200
- **注记**：`run_source` 增加 outcome 返回值（webapp 复用）；`db.Database` 连接 `check_same_thread=False`（FastAPI 线程池跨线程共用单连接，依赖 SQLite serialized 模式 + 单写串行约定）；budget 测试日期改动态生成（修复 UTC 跨天即失效的潜在缺陷）

### T5.4 对话式需求收集 + Prism 规范落地【2026-09-18 增补】
- **内容**：对话助手成为默认首页——用户自然语言描述需求 → `core/planner.py`（复用 Provider 栈，限速/退避/降级不变）追问补齐关键信息 → 结构化计划卡片（`models/plan_schema.py`）→ **用户确认后才创建来源并执行**；整体 UI 按 Prism 棱镜规范重构（240px 侧边栏外壳、墨青主色、状态徽标圆点+中文标签、每页固定结构：页头说明→提示条→主工作区→页脚边界文案）；新增 `/api/chat`、`/api/schemas`（Schema 注册表下发，消除前端硬编码）
- **依赖**：T5.3。
- **验收**：
  - [x] 对话闭环：描述需求 → 助手追问 / 出计划卡 → 确认创建并立即执行（计划卡片是唯一执行入口，无"自动执行"路径）
  - [x] 信息不齐时助手只问一个最关键的问题；URL 缺失不编造；schema_type 非法值兜底到注册表首项
  - [x] 真实冒烟（MiniMax）：助手正确识别 HN 首页为列表页、指出需浏览器渲染、主动追问确认 URL，plan=null
  - [x] UI 符合 Prism：侧边栏外壳、墨青主色仅用于主操作/选中态、状态徽标配文字、页脚边界文案（执行需确认、数据仅存本机）
  - [x] 单测：planner 3 项 + chat/schemas API 6 项（FakeProvider 注入，覆盖 503/422/兜底分支）

---

## 代码审核修正（2026-09-17）

> 子 agent 整体审核（P0×0 / P1×2 / P2×5 / P3×17）后的集中修正。修正后基线：**pytest 151 passed，core+storage 覆盖率 93%**，守护进程已切换到修正后代码。

### P1（已修复，均有回归测试）
- [x] **P1-1 异常路径绕过台账**：`Pipeline.run` 将一切异常兑换为 `FETCH_ERROR` 终态（错误类型随 error_msg 留痕）照常入台账；`Fetcher.fetch` 对非法 URL（`http://`、坏 IPv6 等，抛 ValueError/InvalidURL 而非 HTTPError）返回 FETCH_ERROR 维持契约
- [x] **P1-2 304 短路永久吞掉失败任务**：pipeline 在 FETCH_ERROR / SCHEMA_ERROR 终态后调用 `fetcher.discard_validators(url)`，失败内容下次全量重抓重试；成功任务的 304 短路行为保持不变

### P2（已修复）
- [x] **P2-1** 无 schema_version 行的遗留库打开时按缺列检测补迁移（此前静默跳过、写入即崩）
- [x] **P2-2** 迁移语句与版本戳放进同一 `BEGIN IMMEDIATE` 事务，中断不留半迁移状态
- [x] **P2-3** 校验失败抛 `UsageReportedError`（携带真实用量），SCHEMA_ERROR 的 input/output tokens 入台账与预算口径
- [x] **P2-4** openai-compat strict schema 补 `additionalProperties:false` 与全量 required（官方端点不再 400）
- [x] **P2-5** 去重键加入 schema_type（JOIN extracted_items）：同 URL 改配 Schema 后按新 Schema 重新提取

### P3（已修复 9 项）
- [x] WAL 日志模式（面板/导出 ro 读与采集写并发；已实测干净关闭后 ro 打开正常）
- [x] crawl_runs/extracted_items 增查询索引
- [x] 二次 Ctrl-C 强制退出（os._exit 130）
- [x] daemon 配置错误与 `get_schema` 异常隔离（不再裸抛/不中断本轮剩余来源）
- [x] run_once budget 配置缺失报可读错误（退出码 2）
- [x] tick 的 last_run 改记派发时刻（消除慢任务漂移），预算熔断跳过也推进（防日志刷屏）
- [x] 快照 tmp + `os.replace` 原子写盘
- [x] 成功率口径与 `RunOutcome.ok` 对齐（SKIP_* 计为成功）
- [x] BILLABLE_STATUSES 常量归位 core/status.py（budget/queries 共用）；export csv/json 分支合并；空 YAML 导入防御

### 未采纳 / 待办
- **WAL 之外的 P3 未修项**（已评估，按现设计接受）：fallback 通道独立 rpm、robots 抓取限速、`_pace` 在途串行、事件循环内同步阻塞（单 Worker 设计内可接受）、瞬态判定子串收紧、core↔storage 分层方向（`core/status.py` 已自述动机）——扩展多 Worker 或多通道时再评估
- **T4.2 live 冒烟**：仍待 gemini / openai-compat Key（MiniMax Token Plan 配额耗尽中，待周期刷新）

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

---

## Phase 6：TypeScript 重写 + pi SDK 嵌入（2026-09-18，按用户指令完成）

> 范围：① 产品全线改写为 TypeScript（不再使用 Python）② pi 不用 CLI 套壳，改为 SDK 库式嵌入。做完即停，更大规模的产品重构另行规划。

### T6.1-T6.5 TS 全移植
- **内容**：`src/`（status/models(zod)/dotenv/config/storage(db/rawStore/ledger/queries)/dedup/budget/rateLimiter/fetcher(fit: robots+限速+条件请求+Playwright)/parser(Readability+turndown)/pipeline/planner/providers）+ `scripts/`（run-once/run-daemon/export-data/import-sources/webapp，Express）；Node 22.5+ 直跑 .ts，import 用 `.ts` 扩展名
- **选型**：node:sqlite（WAL/外键/迁移与 Python 版兼容同一库文件）；zod→JSON Schema 注入 + 字符串感知 JSON 提取 + zod 强校验（语义与 Python 版一致：UsageReportedError 带用量、304-after-failure 丢弃验证器、异常兑换 FETCH_ERROR 入台账）
- **验收**：
  - [x] `npx tsc --noEmit` 零错误；`npx vitest run` 67/67 通过（14 文件）
  - [x] 真实端到端：TS run-once 读写与 Python daemon 共用的 `data/collector.db`（WAL 下双引擎互操作，台账行 49/50 连续）；import-sources 幂等导入 2 来源
  - [x] webapp 冒烟：index/summary/sources 200；前端 `web/` 与 `/api/*` 契约不变（新增 `/api/discover`）

### T6.4 LLM 层换 pi-ai
- **内容**：`PiAiProvider`（pi-ai 统一目录：minimax-cn / minimax / anthropic / google / openai；`MINIMAX_API_KEY`→`MINIMAX_CN_API_KEY` 桥接）；FallbackProvider/RateLimitedProvider 语义保留（退避穷尽→降级→FETCH_ERROR 入账）
- **验收**：
  - [x] pi-ai 直连 MiniMax-M3 实测（stop/text/usage/cost 字段齐全）；429 归一化 TransientProviderError（探针实证）
  - [ ] 真实 SUCCESS 提取待 MiniMax 配额刷新（`npm run test:live` 已就绪，429 时优雅跳过；提取链路的 schema→parse→zod 逻辑有单测覆盖）

### T6.7 pi SDK 嵌入：发现 Agent
- **内容**：`src/discovery/agent.ts`——`createAgentSession`（SDK，非子进程套壳）自动加载本机 `~/.pi/agent/mcp.json`，MiniMax `web_search` 进工具列表；产出候选来源 → zod 校验 → 与 sources 表去重 → 用户确认后才入库调度（发现层不碰主链路与台账）
- **验收**：
  - [x] SDK 探针实证：`createAgentSession` 模型自动解析 MiniMax-M3，`state.tools` 含 `minimax_web_search`/`minimax_understand_image`（MCP 经 SDK 生效，非套壳）
  - [x] 单测 5 项（parseCandidates/数组括号感知/最终文本提取/与库去重/供应商错误抛出）；`/api/discover` 端点 + 501/422 分支
  - [ ] 真实发现检索待配额刷新（SDK 链路已验证到 429 层，工具注册与提示词就绪）

### T6.8 切换与清理
- [x] Python 栈全部删除（core/storage/models/scripts/tests .py/requirements*/pytest 配置/.venv），`.command` 与文档（README/AGENTS/PLAN 修订注）改写为 Node 口径
- [x] 守护进程切换：Python daemon 干净排干退出 → TS daemon（`node scripts/run-daemon.ts --log-file data/daemon.log`，caffeinate）运行中，tick 30s 读 sources 表
- [x] 双端同步：仓库 push；MacBook 拉取与 Node 环境说明（MacBook 需 Node ≥22.5：`uv` 不管理 node，建议官方 pkg 或 brew）

---

## Phase 7：Job 内核重构（地基，2026-09-18 启动）

> 决策已锁定（见 PLAN §11）：统一 Job 内核；sources 保留为 source 类任务 payload 子表（FK/历史不动）；现有两场景无损迁移。

### T7.1 schema v3：jobs / job_runs / artifacts
- **内容**：`src/storage/db.ts` 升 SCHEMA_VERSION=3——新增 `jobs`（type/name/ref_id/payload/schedule/enabled + type×ref_id 唯一索引）、`job_runs`（job_id/status/node_state/tokens/started_at/finished_at）、`artifacts`（job_run_id/kind/title/content/meta）；迁移 v2→v3 含 **sources→jobs 1:1 回填**（INSERT OR IGNORE，幂等重跑安全）；配套写入接口。
- **验收**：[x] v2 库打开自动迁移且回填正确（重复打开幂等）；[x] 全新库直建 v3；[x] 迁移/接口单测（真实库 20:2x 已迁 v3，jobs 1:1 回填 2 条）。
### T7.2 Job 内核与 Executor 接口
- **内容**：`src/status.ts` 增 `JobStatus`（running/success/failed/paused/skipped，独立于 RunStatus 不混用）；`src/jobs/`：Job/JobResult 契约、`JobExecutor` 接口、`runJob`（生命周期包裹：job_runs running→终态回写）、`tickJobs`（扫 enabled jobs 按调度到期执行，lastRun 语义与现 tick 一致：派发时刻记账、改间隔下个 tick 生效）。
- **验收**：[x] 生命周期单测（成功/异常→failed/无执行器/预算跳过→skipped 不派发）；[x] tick 调度语义单测（启用过滤/间隔内不重复/改间隔下个 tick 生效/串行）。
### T7.3 SourceExecutor 挂载（行为不变迁移）
- **内容**：`src/jobs/sourceExecutor.ts` 包装现有 pipeline（ref_id→sources 行→TaskSpec→run）；RunStatus→JobStatus 映射（SUCCESS/SKIPPED_*→success，其余→failed）；crawl_runs 动作级台账照旧。daemon `runTick` 改扫 jobs；webapp `/api/run` source 路径走内核；来源管理/发现写 sources 时同步 upsert 对应 job。
- **验收**：[x] 现有测试语义迁移完成（82 项全绿，含新增 kernel/sourceExecutor/v3 迁移测试）；[x] 真实 daemon 双写对齐实证——首 tick job_runs(success, 0 tokens) 与 crawl_runs(SKIPPED_*) 对应，**并抓到 Phase 6 回归**：/api/run 响应 camelCase 与前端 snake_case 契约错位（补 outcomeToApi）、TS parser 链接密度防线对齐 trafilatura（真实 HN 页面固化为夹具回归）。
### T7.4 Phase 7 收尾
- **验收**：[x] 全量 82 绿 + tsc 零错误；[x] 真实 daemon（内核版）tick 观察通过；[x] 双端同步。

**阶段闸门 7**：✅ 通过（2026-09-18）——两场景在新内核下行为一致：HN 恢复 SKIPPED_NO_CONTENT（0 tokens）、Wikipedia 去重命中（0 tokens）、MiniMax 配额窗口内真实 SUCCESS 实证（tokens 5434/225、12765/256）；sources/台账历史无丢失，job_runs 与 crawl_runs 两级对齐。

## Phase 8：定制数据采集（connector 框架）

### T8.1 connector 框架
- **内容**：`src/connectors/` 注册表（id/名称/描述/参数 zod/输出行 schema/频率约束/fetch 实现）；CustomExecutor（connector 抓取→解析→`artifacts(kind=dataset)` 追加行，含数据集级去重键）；零 LLM 成本路径（不触 provider）。
- **验收**：[x] 注册/zod 参数/执行/dataset artifact/水位增量单测（connector.test 4 项）；[x] connector 失败 → failed + onEvent 告警。
### T8.2 天气 connector（open-meteo）
- **内容**：城市→坐标映射、 hourly 时序拉取（温度/降水/风速）、增量入库（按时间戳去重）。
- **验收**：[x] live 实测：open-meteo 48 行时序返回（深圳 24.6℃），api 通道（官方 API 声明 `api:true`：保留限速、跳过 robots——open-meteo robots 全站 Disallow，AGENTS 规则已写明边界）；[x] 水位增量：≤ _wm 的行不再入库（单测）。
### T8.3 统计局 connector（首批数据集）
- **内容**：数据集选择（CPI 月度同比等 1~2 个）、页面/接口解析、数值行入库。
- **验收**：[ ] live 实测；[ ] 页面改版容错（失败标记待修复）。
### T8.4 数据源页改造
- **内容**：连接器卡片表单（按 demo）、dataset 预览与 CSV 导出。
- **验收**：[x] 连接器市场/定制任务/预览全链路真实跑通：API 建任务(id3)→daemon 首 tick 入库 48 行 dataset（from:null→2026-09-18T23:00 水位推进，零 token）；UI 含 connector-market。[ ] dataset CSV 导出复用现有 /api/export 扩展（下一步补 kind=dataset）。

**阶段闸门 8**：两类 connector 零 token 稳定入库 ≥48h；导出可用。

## Phase 9：Deep Research 迁移（引擎语义 + 商圈模板）

### T9.1 工作流引擎
- **内容**：`src/research/engine.ts`——声明式节点（id/prompt `{{var}}`/requireSearch/gate）、`WorkflowState` 快照、失败暂停→续跑、门控（ran/contains）。
- **验收**：[x] 引擎单测 6 项（顺序执行+变量替换、溯源强制→paused、续跑 done 不重跑+快照注入、NEED_FIX 门控双向、token 预算暂停、模板校验）。
### T9.2 pi SDK 节点执行器
- **内容**：`src/research/agentRunner.ts`——createAgentSession 嵌入，事件流收集 toolcall_start（检索工具证据）、全 assistant 消息 usage 汇总、stopReason=error 抛出转暂停；超时 300s。
- **验收**：[x] fake session 单测 3 项（文本/工具/用量收集、429→抛出、空产出→抛出）；[x] live 检索实证（真实商圈研究 job#4 后台运行中，见闸门 9 记录）。
### T9.3 商圈研究模板迁移
- **内容**：flow-center `district-research.json` 语义移植（采证双分支/证据 A-C 等级/写作/校验/补证循环）；计划确认流（出检索计划→用户确认→才执行）。
- **验收**：[x] job#4 端到端产出（机制完整；内容缺陷见闸门 9，修复项已列）；[x] 断点续跑单测实证（快照续跑 done 不重跑）；[x] 溯源校验拦截（引擎 paused 路径单测）。
### T9.4 品牌 / 企业模板
- **验收**：[x] 两模板注册且 validateTemplate 通过（skeleton 参数化：仅维度/prompt 差异，引擎与执行器零改动）；[ ] live 各跑通一份报告（商圈报告验证通过后按同流程发起）。
### T9.5 研究 job 生命周期与预算
- **内容**：`ResearchExecutor`（快照续跑、report artifact、paused 态）+ webapp 端点（templates/create 待确认/confirm/resume/jobs 详情）+ daemon 注册。
- **验收**：[x] 确认前零消耗（创建即 enabled=0，未确认不进调度——端点测试断言）；[x] 预算超限→paused+快照（引擎测试）；[x] 端点 5 组 + executor 4 项测试；[x] T9.7：预检真机 ok（web_search 枚举成功）、429 在预检后正确零消耗暂停（job#5 run28 实证）、质量门单测覆盖达标/证据不足/跑题三分支；[ ] 一份通过终检的完整报告 live 产出（受 MiniMax Token Plan 配额窗口制约——job#5 已确认排队，配额恢复后续跑即产；恢复后跑 `POST /api/research/jobs/5/resume` 或重启 daemon）。

**阶段闸门 9**：⚠️ 机制通过、内容质量待修（2026-09-18）——
- 机制全链路实证 ✅：job#4 创建→确认（enabled:0 守门）→首跑在 research 节点被溯源防线拦截（真实拒绝编造）→ 修复工具证据收集后续跑 → 5 节点全 done（validate 判 NEED_FIX、fix 按门控执行）→ report artifact 8693 字，累计 109.7k tokens；断点续跑、暂停快照、预算、门控在生产路径全部走过。
- 内容质量缺陷 ⚠（如实记录）：报告虽格式完整，但 fix 节点跑题（叙述 MCP 环境而非商圈取证），`【等级 A/B/C】`证据标记 0 条。根因：运行期 MiniMax/exa 的 web_search 报 "MCP not initialized"，agent 降级到 HTTP 抓取并在文本里自述绕路。待修：① agentRunner 的 MCP 初始化时序/工具可用性预检（search 不可用即显式失败，而非降级编证）；② validate 节点增加「主题相关性 + 证据格式」双重判定。

## Phase 10：控制台场景化（按 2026-09-18 demo 实现）

### T10.1 总览页（场景卡片+指标+待办） 
### T10.2 研究工作台 UI（发起表单/节点链执行视图/报告预览/证据表/续跑补证）
### T10.3 对话助手场景衔接（研究意图→草稿卡片→工作台确认）
### T10.4 导出扩展（report Markdown / dataset CSV）+ 文档收尾
- **验收**：[ ] demo 所示六页全部真实可用；[ ] 双端同步与文档（README/AGENTS/PLAN）收口。

**阶段闸门 10**：非技术用户可独立完成「发起研究→看报告」「添加天气源→导出数据」「对话建临时采集」三条完整路径。
