# 智能数据采集与结构化工具开发落地方案与实施计划

> **文档版本**：v2.0（Provider 无关架构）
> **修订日期**：2026-09-16
> **适用对象**：希望以近零边际成本构建自动化采集与结构化提取工具的开发者。
>
> **v1.1 → v2.0 核心变更**：移除对 Google Antigravity CLI（`agy`）的强依赖，不再绑定任何 CLI 工具与消费级订阅登录态。LLM 推理改为通过**标准 API**（Gemini API 免费层 / 任意 OpenAI 兼容端点 / 本地模型）接入，抓取与提取职责解耦为自有模块。文末附完整差异对照表。

---

## 一、 产品定位与核心目标

### 1.1 产品概述

本项目旨在构建一套**自适应、低维护成本、供应商可替换的智能数据采集与结构化分析工具**（Agentic Scraper & Data Collector）。

传统爬虫存在两大核心痛点：

1. **页面脆弱性**：目标站点前端改版或 DOM 结构微调会导致 CSS 选择器、XPath 规则立即失效，维护成本极高；
2. **非结构化数据提炼困难**：面对图文混排、动态摘要、行业研报，难以自动化提炼出符合业务字段规范的强类型结构化数据。

本方案采用**"自有抓取 + API 化语义提取"**的分职责架构：抓取层由 `httpx`（静态页面）与 `Playwright`（动态页面，可选）完成，正文抽取交给 `trafilatura`；语义提取通过 **Provider 抽象层**调用任意 LLM API，并使用**原生 Structured Output** 直接产出符合 Pydantic Schema 的强类型数据，实现：

```
YAML 配置采集目标
  → 自有抓取层拉取 HTML（robots 合规 + 按站点限速）
  → trafilatura 正文抽取 → 干净 Markdown
  → SHA-256 内容快照存档 + 提取前去重（内容未变 → 0 次 LLM 调用）
  → LLM Provider API 语义提取（原生 Structured Output）
  → Pydantic 强类型校验
  → SQLite 持久化 + 运行台账
```

### 1.2 核心价值主张

| 价值点 | 说明 |
| :--- | :--- |
| **近零边际成本** | 默认走 Gemini API 免费层；亦可配置 OpenRouter 免费模型、按量付费模型或本地 Ollama（真零成本） |
| **供应商可替换** | LLM 接入收敛到 Provider 接口后面，配额、价格、模型变更时改配置即切换，不绑定任何 CLI 或单一厂商 |
| **抗改版语义抓取** | 基于 LLM 理解正文语义提炼字段，DOM 结构变更不影响抽取稳定性 |
| **强类型输出保证** | 原生 Structured Output + Pydantic v2 双重约束，无需依赖 Prompt 注入 Schema 与容错 JSON 修复 |
| **提取前去重** | 内容哈希未变的 URL 直接跳过 LLM 调用，成本可控且可预测（每次调用的 Token 用量明确可知） |
| **轻量常驻部署** | 纯 Python + HTTP 调用，无常驻子进程、无登录态续期问题，macOS / Linux 均可运行 |
| **可追溯证据链** | 原始快照 SHA-256 哈希存档 + 元数据台账，每条结构化数据均可回溯至原始来源 |

### 1.3 适用场景与边界

**适用于**：
- 行业资讯、竞品动态、政策文件的定期自动化采集与结构化清洗
- 舆情监测、价格追踪、技术社区热点聚合
- 面向分析人员的信息底座建设（Knowledge Base Ingestion）

**不适用于**（明确排除）：
- 绕过登录鉴权、robots.txt 或付费墙的数据抓取
- 大规模高并发采集（日均请求量万级）
- 个人身份信息、企业机密或依赖真实凭证的私有数据源

---

## 二、 前置条件核查（启动前必须完成）

> 在进入开发阶段前，逐项验证以下条件。与 v1.1 的最大区别：**不需要任何 CLI 工具与订阅登录态，只需要一个 API Key（免费可得）**。

| 检查项 | 验证方式 | 预期状态 |
| :--- | :--- | :--- |
| Python 版本 | `python3 --version` | `3.10+` |
| LLM 凭据（至少一项） | 环境变量 `GEMINI_API_KEY` 或 `OPENAI_API_KEY` / `OPENROUTER_API_KEY` 等 | Key 存在且有效 |
| 凭据连通性 | `curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"` | 返回模型列表 JSON，无 401/403 |
| 免费层配额确认 | 查阅所选 Provider 官方定价页当前的 RPM / RPD（每日请求数）限制 | 限制值 ≥ 计划日均任务数的 2 倍 |
| Python 依赖 | `pip install httpx trafilatura pydantic apscheduler` | 无安装错误 |

> 凭据获取说明：Google AI Studio（aistudio.google.com）可免费申请 `GEMINI_API_KEY` 并使用免费层配额；OpenRouter 提供免费模型；本地安装 Ollama 则无需任何外部 Key。

---

## 三、 系统整体架构设计

系统划分为**任务调度层、采集流水线层、抓取与正文抽取层、LLM Provider 抽象层、存储持久化层**五个层级，各层之间通过明确的数据契约解耦：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         1. 任务调度与管理层 (Scheduler)                  │
│   • 定时轮询 (APScheduler: cron / interval)                             │
│   • 按需单次触发 (CLI 脚本)                                              │
│   • 任务队列管理 (串行 Worker + 每站点限速，防突发并发)                  │
└──────────────────────────────────────────┬──────────────────────────────┘
                                           │ 派发: TaskSpec { url, schema, provider_config }
                                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     2. 采集流水线层 (Pipeline)                           │
│   • 编排: fetch → parse → snapshot → dedup → extract → store            │
│   • 运行台账记录（状态机: SUCCESS / FETCH_ERROR / BLOCKED /             │
│     SKIPPED_UNCHANGED / SCHEMA_ERROR）                                  │
│   • 日预算熔断（任务数 / Token 数双上限）                                │
└───────┬──────────────────────────────┬──────────────────────────────────┘
        ▼                              ▼
┌───────────────────────────┐  ┌─────────────────────────────────────────┐
│ 3. 抓取与正文抽取层        │  │   4. LLM Provider 抽象层 (可替换)       │
│  (Fetch & Parse)          │  │   • LLMProvider 协议接口                │
│ • httpx 异步拉取 HTML     │  │   • GeminiProvider  (google-genai SDK)  │
│ • robots.txt 合规检查     │  │   • OpenAICompatProvider (OpenAI /      │
│ • 按域名限速 + 条件请求    │  │     OpenRouter / DeepSeek / vLLM /      │
│ • trafilatura 正文抽取     │  │     Ollama 等任意兼容端点)              │
│ • Playwright (可选, P4)   │  │   • 原生 Structured Output              │
└───────────┬───────────────┘  │   • 429/5xx 指数退避 + 供应商 fallback   │
            │ 正文 Markdown    │   • 凭据全部来自环境变量                 │
            ▼                  └────────────────┬────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────┐
│                      5. 语义校验与存储持久化层                            │
│   • Pydantic v2 强类型反序列化（失败仅追加一次纠错重试）                │
│   • 原始快照: data/raw/{sha256}.md (内容哈希寻址，防篡改)               │
│   • 结构化数据: data/collector.db (SQLite，三张核心表)                  │
│   • 运行台账: 任务 ID、URL、Provider、Token 消耗、成功/失败状态         │
└─────────────────────────────────────────────────────────────────────────┘
```

**与 v1.1 架构的关键差异**：原方案的"Antigravity Agent 适配层"（子进程生命周期、心跳检测、周期重建、stderr 分流、OAuth 登录态）整体移除——纯 HTTP API 调用不存在这些复杂度，健壮性需求收敛为标准的超时、重试与退避。

---

## 四、 核心模块与技术选型

| 模块 | 核心职责 | 技术选型 | 关键说明 |
| :--- | :--- | :--- | :--- |
| **HTTP 抓取** | 静态页面拉取 | `httpx` | 异步、HTTP/2、精细超时控制、连接复用 |
| **正文抽取** | HTML → 干净 Markdown | `trafilatura` | 成熟的去噪/正文识别能力，直接输出 Markdown |
| **LLM 接入** | 语义理解与字段提炼 | Provider 抽象 + `google-genai` / `openai` / `anthropic` SDK | 供应商可配置可替换，凭据走环境变量 |
| **结构化输出** | 输出格式硬约束 | 嫁接在各 Provider 的**原生 Structured Output** 上 | Gemini `response_schema` / OpenAI `json_schema` 模式 |
| **数据建模与校验** | 目标字段定义 | `Pydantic v2` | 同一份模型类既生成 API 约束又做落库前校验 |
| **任务调度** | 定时 / 周期执行 | `APScheduler 3.x` | `cron` 与 `interval` 两种策略 |
| **本地关系存储** | 落库与台账 | `SQLite` + `sqlite3` 标准库 | 轻量免部署；数据量 >10GB 时可迁移 DuckDB |
| **原始快照存档** | 防篡改存储 | 本地文件系统 + SHA-256 | 内容哈希命名，天然去重 |
| **动态渲染扩展** | JS 渲染站点 | `Playwright`（可选，Phase 4） | 独立 Fetcher 实现，按站点配置启用 |

> `dirtyjson` 在 v2.0 中降级为可选兜底依赖：原生 Structured Output 之后，非标准 JSON 出现概率极低，仅在个别不支持 schema 模式的兼容端点上可能用到。

---

## 五、 关键技术设计细节

### 5.1 LLM Provider 抽象层

所有 LLM 访问收敛到一个协议接口后面。新增供应商 = 新增一个实现类 + 一段配置，其余代码零改动：

```python
# core/providers/base.py
from typing import Protocol, TypeVar, runtime_checkable
from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)

@runtime_checkable
class LLMProvider(Protocol):
    name: str

    async def extract(self, content: str, schema: type[T],
                      *, instruction: str = "") -> "ExtractionResult":
        """输入正文与 Pydantic 模型，返回强类型对象与 Token 用量。"""
        ...
```

**Gemini 实现（默认，走免费层）**：

```python
# core/providers/gemini.py
import os
from google import genai
from google.genai import types

class GeminiProvider:
    name = "gemini"

    def __init__(self, model: str = "gemini-flash-latest"):  # 模型名以官方文档当前稳定版为准
        if not os.environ.get("GEMINI_API_KEY"):
            raise RuntimeError("缺少 GEMINI_API_KEY 环境变量")
        self.client = genai.Client()  # 自动读取 GEMINI_API_KEY
        self.model = model

    async def extract(self, content, schema, *, instruction=""):
        resp = await self.client.aio.models.generate_content(
            model=self.model,
            contents=f"{instruction}\n\n{content}",
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=schema,  # SDK 直接接受 Pydantic 模型，服务端硬约束输出
            ),
        )
        u = resp.usage_metadata
        return ExtractionResult(
            item=schema.model_validate_json(resp.text),
            input_tokens=u.prompt_token_count or 0,
            output_tokens=u.candidates_token_count or 0,
            provider=self.name, model=self.model,
        )
```

**OpenAI 兼容实现（覆盖 OpenAI / OpenRouter / DeepSeek / vLLM / Ollama）**：

```python
# core/providers/openai_compat.py
class OpenAICompatProvider:
    """任意 OpenAI 兼容端点：base_url + api_key_env 均由配置注入。"""
    name = "openai-compat"

    def __init__(self, model: str, base_url: str | None = None,
                 api_key_env: str = "OPENAI_API_KEY"):
        self.client = AsyncOpenAI(base_url=base_url,
                                  api_key=os.environ[api_key_env])
        self.model = model

    async def extract(self, content, schema, *, instruction=""):
        resp = await self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "system", "content": instruction or DEFAULT_SYSTEM},
                      {"role": "user", "content": content}],
            response_format={"type": "json_schema",
                             "json_schema": {"name": schema.__name__,
                                             "schema": schema.model_json_schema(),
                                             "strict": True}},
        )
        ...
```

**Anthropic 协议兼容实现（`core/providers/anthropic_compat.py`）**：覆盖 Anthropic 官方 API 与 MiniMax 等 Anthropic 协议端点（如 `https://api.minimax.cn/anthropic` + `MiniMax-M3`）。Messages API 无服务端 json_schema，Schema 以 Prompt 注入 + Pydantic 强校验兜底；思考型模型的思考内容不在 text 块中，仅拼接 text 块。

**配置示例（`config/settings.yaml`）**：

```yaml
provider:
  primary: gemini            # 主供应商
  fallback: openai-compat    # 主供应商连续失败时自动切换
  gemini:
    model: gemini-flash-latest
  openai-compat:
    model: deepseek-chat     # 示例：亦可为 OpenRouter 免费模型或本地 Ollama 模型
    base_url: https://api.deepseek.com/v1
    api_key_env: DEEPSEEK_API_KEY

budget:
  max_tasks_per_day: 300
  max_input_tokens_per_day: 2000000

fetch:
  min_interval_per_host_s: 5
  respect_robots: true
  user_agent: "DataCollectorBot/0.1 (personal research; contact: you@example.com)"
```

### 5.2 抓取层：合规、限速与条件请求

抓取从 agy 内置工具（行为黑盒）收回为自有代码，因此**反爬与合规责任也收回自有**，需显式处理：

```python
# core/fetcher.py 核心骨架
import asyncio, time
import httpx
import urllib.robotparser

class Fetcher:
    def __init__(self, ua: str, min_interval: float = 5.0):
        self._client = httpx.AsyncClient(
            headers={"User-Agent": ua},
            timeout=httpx.Timeout(30.0),
            follow_redirects=True,
        )
        self._min_interval = min_interval      # 同一域名两次请求的最小间隔
        self._last_hit: dict[str, float] = {}  # host → 上次请求时间戳
        self._robots: dict[str, urllib.robotparser.RobotFileParser] = {}

    def _robots_allows(self, url: str) -> bool:
        """robots.txt 检查（按域名缓存解析结果），默认拒绝不可达时的策略可配置。"""
        ...

    async def _pace(self, host: str):
        """同域名串行 + 最小间隔，避免触发目标站风控。"""
        ...

    async def fetch(self, url: str) -> "FetchResult":
        if not self._robots_allows(url):
            return FetchResult(status="BLOCKED", reason="robots.txt disallow")
        await self._pace(httpx.URL(url).host)
        resp = await self._client.get(url)
        # 200 → OK；403/429 → BLOCKED（标记告警，后续可升级 Playwright）；其余 → FETCH_ERROR
        ...
```

配套两项低成本优化：
- **条件请求**：对支持 `ETag` / `Last-Modified` 的站点携带缓存验证头，304 响应直接短路（连正文抽取都省掉）；
- **正文抽取**：`trafilatura.extract(html, output_format="markdown", include_comments=False)`，失败（如纯列表页无正文）记 `SKIPPED_NO_CONTENT` 状态，不浪费 LLM 调用。

### 5.3 提取前去重：成本控制的第一道闸门

v1.1 中抓取与提取在 agy 内部一体完成，即使内容毫无变化也必然消耗一轮 Agent 调用。v2.0 把去重提到 LLM 之前：

```python
# core/pipeline.py 核心骨架
class Pipeline:
    async def run(self, task: TaskSpec) -> RunOutcome:
        fetched = await self.fetcher.fetch(task.url)
        if fetched.status != "OK":
            return self._record(task, status=fetched.status, error=fetched.reason)

        markdown = trafilatura.extract(fetched.html, output_format="markdown")
        if not markdown:
            return self._record(task, status="SKIPPED_NO_CONTENT")

        raw_hash = await self.raw_store.save(markdown)          # SHA-256 内容哈希快照
        if self.dedup.seen(task.url, raw_hash):                 # URL + 哈希均未变
            return self._record(task, status="SKIPPED_UNCHANGED",
                                raw_hash=raw_hash)              # ← 0 次 LLM 调用、0 Token

        result = await with_backoff(
            lambda: self.provider.extract(markdown, task.schema,
                                          instruction=task.instruction)
        )
        item = validate_or_retry_once(result, task.schema)      # 至多一次纠错重试
        return self._record(task, status="SUCCESS", item=item,
                            tokens=(result.input_tokens, result.output_tokens))
```

**校验失败处理**：原生 Structured Output + Pydantic 校验失败时，**重新发起一次全新调用**（把失败原因写入 instruction 作为纠错提示），而不是在同一会话里追加消息——没有会话上下文，也就不存在 v1.1 担心的上下文膨胀问题。两次仍失败记 `SCHEMA_ERROR` 并继续下一个任务。

### 5.4 限流退避与供应商降级

替代 v1.1 的 `quota_guard.py`（原为感知消费配额错误），v2.0 处理的是标准 HTTP 语义，逻辑更简单确定：

```python
# core/rate_limiter.py 核心骨架
import asyncio, random

async def with_backoff(fn, *, max_retries=5, base=2.0, cap=300.0):
    """429 / 5xx 归一化异常后指数退避 + 随机抖动：~2s → 4s → 8s → 16s → 32s。"""
    for attempt in range(max_retries):
        try:
            return await fn()
        except TransientProviderError:              # Provider 实现将 429/5xx 统一抛此异常
            if attempt == max_retries - 1:
                raise
            await asyncio.sleep(min(cap, base * 2 ** attempt) + random.uniform(0, 1))
```

两级保护：
- **主动限速**：按 Provider 免费层 RPM 配置令牌桶，从源头避免触发 429；
- **被动降级**：主供应商重试穷尽后自动切换 `fallback` 供应商继续本轮任务，并在台账中记录实际使用的 provider。

### 5.5 数据库 Schema 设计

```sql
-- sources: 采集来源配置白名单
CREATE TABLE IF NOT EXISTS sources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT NOT NULL UNIQUE,
    name        TEXT,
    schema_type TEXT NOT NULL,              -- 对应的 Pydantic Schema 类名
    interval_s  INTEGER DEFAULT 3600,
    enabled     INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
);

-- crawl_runs: 每次采集任务的运行台账
CREATE TABLE IF NOT EXISTS crawl_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id      INTEGER REFERENCES sources(id),
    raw_hash       TEXT,
    status         TEXT NOT NULL,           -- SUCCESS / FETCH_ERROR / BLOCKED /
                                            -- SKIPPED_UNCHANGED / SKIPPED_NO_CONTENT / SCHEMA_ERROR
    provider       TEXT,                    -- 实际完成提取的供应商（含 fallback 切换）
    model          TEXT,
    input_tokens   INTEGER,
    output_tokens  INTEGER,
    duration_ms    INTEGER,
    error_msg      TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
);

-- extracted_items: 结构化提取结果（通用 JSON 存储，支持多 Schema 类型）
CREATE TABLE IF NOT EXISTS extracted_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER REFERENCES crawl_runs(id),
    source_url  TEXT NOT NULL,
    schema_type TEXT NOT NULL,
    content     TEXT NOT NULL,
    dedup_hash  TEXT UNIQUE,
    created_at  TEXT DEFAULT (datetime('now'))
);

-- 建议附加上 schema_version 元数据表，便于后续迁移
```

---

## 六、 项目工程结构规划

```plaintext
data-collector/
├── config/
│   ├── settings.yaml            # Provider、预算、抓取行为配置
│   └── sources.yaml             # 来源白名单与对应 Schema 配置
├── core/
│   ├── pipeline.py              # 采集流水线编排（fetch → parse → dedup → extract → store）
│   ├── fetcher.py               # httpx 抓取 + robots 合规 + 域名限速 + 条件请求
│   ├── parser.py                # trafilatura 正文抽取封装
│   ├── dedup.py                 # URL + 内容哈希去重（LLM 调用前置闸门）
│   ├── rate_limiter.py          # 令牌桶限速 + 指数退避 + 供应商 fallback
│   └── providers/
│       ├── base.py              # LLMProvider 协议与 ExtractionResult 契约
│       ├── gemini.py            # Gemini API 实现（默认）
│       └── openai_compat.py     # 任意 OpenAI 兼容端点实现
├── models/
│   ├── base_schema.py           # 公共基础字段（source_url、scraped_at）
│   ├── news_schema.py           # 行业资讯 / 舆情监测 Schema
│   └── competitor_schema.py     # 竞品动态 / 研报摘要 Schema
├── storage/
│   ├── db.py                    # SQLite 初始化、三表写入接口
│   └── raw_store.py             # SHA-256 内容哈希快照存储与读取
├── scripts/
│   ├── run_daemon.py            # 后台守护进程入口（APScheduler 常驻）
│   ├── run_once.py              # 按配置单次执行所有采集源
│   └── export_data.py           # 导出为 CSV / JSON / Markdown
├── tests/
│   ├── test_fetcher.py          # robots / 限速 / 状态分类（本地 fixture 页面）
│   ├── test_pipeline.py         # 全流水线集成（Mock Provider + 真实存储）
│   ├── test_providers.py        # Provider 契约测试（对真实 API 的冒烟子集）
│   └── test_rate_limiter.py     # 退避与降级逻辑
├── data/
│   ├── raw/                     # 历史原始抓取快照（{sha256}.md）
│   └── collector.db             # SQLite 本地数据库
├── requirements.txt             # httpx, trafilatura, pydantic>=2.0, apscheduler,
│                                # google-genai, openai（后两者按所用 Provider 安装）
├── .env.example                 # GEMINI_API_KEY= / DEEPSEEK_API_KEY= ...
└── README.md
```

---

## 七、 实施计划与四阶段推进里程碑

项目预计 **8 个工作日** 完成。相比 v1.1，移除子进程管理后 Phase 3 复杂度显著下降，工期留有更多余量。

```
Day 1~2  ▌ Phase 1: 抓取通道与 MVP 验证
Day 3~4  ▌ Phase 2: 存储流水线与去重闭环
Day 5~6  ▌ Phase 3: 定时守护、限流退避与降级
Day 7~8  ▌ Phase 4: 扩展能力与生产封装
```

### Phase 1：抓取通道与 MVP 验证（Day 1~2）

**目标**：打通 抓取 → 正文抽取 → LLM 提取 的端对端链路，并测得单任务 Token 基线。

| 任务 | 负责模块 |
| :--- | :--- |
| 实现 `Fetcher`：httpx 拉取、robots 检查、域名限速、状态分类 | `core/fetcher.py` |
| 实现 `GeminiProvider` 与 `LLMProvider` 协议 | `core/providers/` |
| 实现 `parse_response` 强类型校验（含一次纠错重试） | `core/pipeline.py` |
| 端对端验证脚本：采集公开网页并打印结构化输出 | `scripts/run_once.py` |

**验收标准**：`run_once.py --url <有正文页面>` 打印通过 Pydantic 校验的 JSON 对象，连跑 10 次成功率 ≥ 90%，并输出单任务 Token 消耗实测值（此数据直接决定 Phase 3 的日预算参数）。目标页修订（2026-09-16）：HN 首页实测为聚合列表页，按设计记 `SKIPPED_NO_CONTENT`（见 §10 两段式采集）；验收目标改为 Wikipedia 词条页，HN 首页保留为 SKIPPED 负样本用例。

### Phase 2：存储流水线与去重闭环（Day 3~4）

**目标**：实现从抓取到落库的完整流水线，具备内容去重与版本检测。

| 任务 | 负责模块 |
| :--- | :--- |
| 按 SQL Schema 建库，实现三表写入接口 | `storage/db.py` |
| 实现 SHA-256 快照存储与 URL + 哈希去重 | `storage/raw_store.py`、`core/dedup.py` |
| 集成测试：5 个不同 URL 批量采集并校验落库结果 | `tests/` |

**验收标准**：5 个 URL 采集完成且正确落库；重复执行同一 URL 记录为 `SKIPPED_UNCHANGED` 且 **0 次 LLM 调用**。

### Phase 3：定时守护、限流退避与降级（Day 5~6）

**目标**：实现可长期稳定运行的后台守护服务。

| 任务 | 负责模块 |
| :--- | :--- |
| 接入 `APScheduler`，按 `sources.yaml` 启动定时任务 | `scripts/run_daemon.py` |
| 实现指数退避 + 抖动（429/5xx 归一化处理） | `core/rate_limiter.py` |
| 实现主/备供应商自动降级切换 | `core/providers/` |
| 实现日预算熔断（任务数 / Token 数双上限） | `core/pipeline.py` |

**验收标准**：守护进程连续稳定运行 24 小时，多轮采集无任务丢失；人为注入 429 后可观测到退避与恢复；主供应商不可用时任务自动由 fallback 完成。

### Phase 4：扩展能力与生产封装（Day 7~8）

**目标**：覆盖动态渲染站点并交付完整工具包。

| 任务 | 负责模块 |
| :--- | :--- |
| （可选）Playwright Fetcher：强 JS 渲染站点按配置启用 | `core/fetcher.py` |
| 实现 `OpenAICompatProvider` 并在配置中验证切换 | `core/providers/openai_compat.py` |
| CLI 导出工具：`export_data.py --format csv/json/markdown` | `scripts/export_data.py` |
| 完善测试覆盖率，编写 `README.md`（部署、配置、运维指南） | `tests/`、`README.md` |

**验收标准**：`pip install -r requirements.txt` 一键安装运行；不改代码、仅改配置即可完成供应商切换。

---

## 八、 风险评估与保障措施

| 风险项 | 风险等级 | 具体表现 | 应对措施 |
| :--- | :---: | :--- | :--- |
| **目标网站反爬封锁** | 中高 | 自有抓取层直面风控，强风控站点返回 403 / CAPTCHA / 空白页 | robots 合规 + 域名限速 + 明确 UA 标识 + 条件请求；确认被封锁后按站点配置升级 Playwright；仍失败标记 `blocked` 并告警 |
| **免费层配额与限速** | 中 | 短时任务密集触发 429 或日限额耗尽 | 提取前去重砍掉无效调用；令牌桶主动限速；主/备供应商降级；台账持续跟踪 Token/任务；日预算熔断兜底 |
| **正文抽取质量** | 中 | 列表页、表格页等非正文型页面抽取效果差 | 抽取失败记 `SKIPPED_NO_CONTENT` 不浪费 LLM 调用；"列表页 → 详情页"两段式采集列入演进方向 |
| **API Key 安全** | 中低 | Key 泄露导致滥用或账单损失 | 凭据只走环境变量与 `.env`（入 `.gitignore`）；免费层 Key 不绑信用卡；README 明确告警 |
| **数据格式校验失败** | 低 | 个别端点不支持原生 schema 模式时偶发非标 JSON | Pydantic 校验 + 一次全新纠错重试；`dirtyjson` 作为最后兜底；仍失败记 `SCHEMA_ERROR` 不阻塞队列 |
| **SQLite 写入冲突** | 低 | 多线程/多进程写库锁冲突 | 单 Worker 串行写入；未来需要并发时迁移 DuckDB 或引入写入队列 |

> v1.1 中的高风险项——子进程上下文溢出、OAuth 凭据过期需人工续期、消费级配额自动化使用带来的条款风险、NDJSON 协议稳定性——在 v2.0 架构下**结构性消除**。

---

## 九、 v1.1 → v2.0 差异对照表

| 维度 | v1.1（基于 agy CLI） | v2.0（Provider 无关） |
| :--- | :--- | :--- |
| LLM 接入方式 | 本地 `agy` 子进程 + stream-json NDJSON 管道 | 标准 HTTP API，`LLMProvider` 协议抽象 |
| 抓取执行者 | agy 内置 `read_url_content`（行为黑盒） | 自有 `httpx` + `trafilatura`（+ Playwright 可选） |
| 凭据形态 | Google OAuth 消费登录态，会过期、需人工续期 | API Key 环境变量，无过期续期问题 |
| 结构化约束 | Prompt 注入 JSON Schema + `dirtyjson` 容错修复 | Provider 原生 Structured Output + Pydantic 校验 |
| 成本模型 | 复用 AI Pro 消费配额（有条款风险，消耗不可见） | 免费层 / 按量付费，每次调用 Token 用量明确可测 |
| 无效页面成本 | 内容未变仍消耗一轮 Agent 调用 | 提取前哈希去重，未变内容 0 LLM 成本 |
| 健壮性复杂度 | 子进程心跳、周期重建、stderr 分流、上下文管理 | HTTP 超时 / 重试 / 退避 / 供应商降级 |
| 供应商锁定 | 强绑定 agy（消费级产品，接口无兼容承诺） | 配置即切换：Gemini / OpenAI 兼容 / 本地模型 |
| 主要新增责任 | — | 自有抓取层需直面反爬与合规（已内置应对） |

---

## 十、 后续演进方向（超出本期范围）

1. **CLI Agent 适配器**：如确需 Agent 型运行时（自主多步工具调用），可在 `LLMProvider` 协议旁新增 `AgentProvider` 可选实现接入任意 CLI 工具——仅作插件，不进入核心链路。
2. **两段式采集**：列表页发现 → 详情页深挖，覆盖聚合型页面。
3. **Web UI 管理界面**：已排期为 Phase 5（见 TASKS.md：T5.1 只读监控面板 / T5.2 来源配置管理）——Streamlit 只读面板先行，配置管理随后把来源白名单从 YAML 迁到 sources 表。
4. **智能路由**：按任务复杂度自动路由到不同成本档位的模型（简单字段走免费层，复杂研报走高档模型）。
5. **向量检索集成**：结构化文本嵌入 ChromaDB / Qdrant，支持语义相似性搜索。
6. **Deep Research 工作流对接**：采集入库的证据通过 Knowledge Port 供下游分析系统消费。
