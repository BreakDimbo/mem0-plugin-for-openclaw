# memory-mem0

> OpenClaw 增强型双轨记忆插件 · v1.1.0 · 2026-03-22

为 AI Agent 提供跨会话的长期记忆能力。将非结构化对话内容转化为结构化的持久知识，在每次对话前精准召回，使 Agent 感知用户的历史偏好、目标与约束。

---

## 目录

1. [核心能力](#1-核心能力)
2. [与官方 mem0 插件对比](#2-与官方-mem0-插件对比)
3. [整体架构](#3-整体架构)
4. [模块结构](#4-模块结构)
5. [核心模块详解](#5-核心模块详解)
   - 5.1 [双轨记忆体系](#51-双轨记忆体系)
   - 5.2 [召回管道（Recall Hook）](#52-召回管道recall-hook)
   - 5.3 [统一意图分类器](#53-统一意图分类器)
   - 5.4 [捕获管道（Capture Pipeline）](#54-捕获管道capture-pipeline)
   - 5.5 [LLM 准入门控](#55-llm-准入门控)
   - 5.6 [Outbox 异步写回队列](#56-outbox-异步写回队列)
   - 5.7 [记忆整理系统（Consolidation）](#57-记忆整理系统consolidation)
   - 5.8 [Markdown 同步](#58-markdown-同步)
   - 5.9 [安全机制](#59-安全机制)
6. [配置参考](#6-配置参考)
7. [工具 API](#7-工具-api)
8. [CLI 命令（/memu）](#8-cli-命令memu)
9. [作用域隔离（Scope）](#9-作用域隔离scope)
10. [数据文件](#10-数据文件)
11. [FAQ](#11-faq)

---

## 1. 核心能力

| 能力 | 描述 |
|------|------|
| **双轨记忆** | Core Memory（结构化 KV，本地 JSON）+ Free-text Memory（向量语义，mem0） |
| **自动召回** | `before_prompt_build` 时检索并注入，零代码侵入 |
| **自动捕获** | `agent_end` 后静默提取，不阻塞响应 |
| **统一意图分类** | 查询类型（greeting/code/factual…）+ 复杂度层级（SIMPLE→REASONING）+ captureHint |
| **LLM 准入门控** | 批量判断候选记忆质量（core/free_text/discard），防止噪音写入 |
| **记忆整理系统** | 每日/每周/每月自动整理，Ebbinghaus 衰减评分 + LLM 边界裁决 + dead-letter 保护 |
| **Tier 分层注入** | profile/general 永久注入，technical 按需检索 |
| **中文优先** | CJK bigram 分词、中文数字归一化（第一↔1）、跨语言语义匹配 |
| **多 Agent 隔离** | 完整 Scope（userId + agentId + sessionKey + tenantId），per-agent userId 映射 |
| **安全防护** | 注入攻击检测、敏感信息过滤、XML 转义 |
| **Markdown 同步** | 核心记忆定期写入 MEMORY.md，跨会话文件可读 |

---

## 2. 与官方 mem0 插件对比

### 功能对比

| 维度 | 官方 mem0 插件 | memory-mem0 |
|------|--------------|-------------|
| 记忆模型 | 单一向量记忆 | **双轨**：Core Memory + Free-text |
| Core Memory | ❌ | ✅ 本地 JSON，Tier 分层 |
| 召回率（70 条基准） | 35.7% | **88.6%** |
| 中文支持 | 基础 | **CJK 分词 + 数字归一化 + 语义重排序** |
| LLM 门控 | ❌ | ✅ 三分类（core/free_text/discard） |
| 捕获方式 | 同步阻塞 | **异步流水线，零延迟影响** |
| 记忆整理 | ❌ | ✅ 多周期调度 + Ebbinghaus 评分 + dead-letter |
| 人工审核 | ❌ | ✅ Proposal Queue |
| 工具 API | 3 个 | **9 个** |
| CLI 看板 | ❌ | ✅ `/memu` 完整命令集 |

### 召回率基准（70 条测试集）

| 测试类别 | 官方插件 | memory-mem0 |
|---------|---------|-------------|
| 用户画像（identity） | 40% | **100%** |
| 目标偏好（goals/preferences） | 35% | **90%** |
| 约束规则（constraints） | 30% | **86%** |
| 技术配置（technical） | 30% | **57%** |
| 架构决策（architecture） | 25% | **56%** |
| **整体** | **35.7%** | **88.6%** |

> 技术/架构类偏低是 mem0 后端 `add` API 在存储时会改写内容（翻译为英文、丢失数字精度），属后端限制而非召回层问题。

### 召回率演进

| 版本 | 召回率 | 关键变更 |
|------|------:|---------|
| 基线（官方插件） | 35.7% | 纯 free-text |
| + Core Memory + 重排序 | 75.7% | 本地 KV，语义重排 |
| + 捕获流水线修复 | 78.6% | CLI 模式捕获，LLM 门控，去重修复 |
| + 统一意图分类器 | 88.6% | 智能路由，bge-m3 嵌入 |
| 预填充语料（上限） | 92.9% | 所有事实预存 |

---

## 3. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        OpenClaw Agent                            │
├──────────────────────┬──────────────────────────────────────────┤
│   message_received   │   before_prompt_build     agent_end      │
│         │            │          │                    │           │
│         ▼            │          ▼                    ▼           │
│  InboundMessageCache │   ┌─────────────┐    ┌──────────────┐    │
│  （原始消息缓存）     │   │ 统一意图分类 │    │  捕获 Hook   │    │
│                      │   │  Classifier  │    │  agent_end   │    │
│                      │   └──────┬──────┘    └──────┬───────┘    │
│                      │          │                   │            │
│                      │          ▼                   ▼            │
│                      │   ┌─────────────┐    ┌──────────────┐    │
│                      │   │  Recall Hook │    │ CandidateQueue│   │
│                      │   │ 双层检索+注入│    │ 批量缓冲去重  │   │
│                      │   └──────┬──────┘    └──────┬───────┘    │
│                      │          │                   │            │
│                      │          ▼                   ▼            │
│                      │   ┌─────────────┐    ┌──────────────┐    │
│                      │   │  <core-mem> │    │  LLM Gate    │    │
│                      │   │  <relevant> │    │ core/ft/discard    │
│                      │   │  注入 Prompt│    └──┬───────┬───┘    │
│                      │   └─────────────┘       │       │        │
│                      │                          ▼       ▼        │
│                      │                   CoreRepo   Outbox       │
│                      │                   (本地JSON)  (异步队列)   │
│                      │                                 │         │
│                      │                                 ▼         │
│                      │                            mem0 API       │
│                      │                           (向量数据库)     │
├──────────────────────┴──────────────────────────────────────────┤
│              整理调度器（后台，每小时 tick）                        │
│   daily 03:00 · weekly 周一 04:00 · monthly 每月1日 05:00        │
│   ImportanceScorer → 裁决 → 可选 LLM 裁决 → dead-letter 保护     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. 模块结构

```
memory-mem0/
├── index.ts                    # 插件入口：注册所有 hook/tool/command，生命周期管理
├── types.ts                    # 全量类型定义 + 配置 Schema + 默认值 + loadConfig()
│
├── hooks/
│   ├── recall.ts               # before_prompt_build：查询提取 → 分类 → 双层检索 → 注入
│   ├── capture.ts              # agent_end：对话窗口提取 → 过滤 → CandidateQueue
│   ├── message-received.ts     # 仅缓存原始入站消息（InboundMessageCache）
│   ├── smart-router.ts         # before_model_resolve：按复杂度层级路由模型
│   └── utils.ts                # stripInjectedBlocks、extractTextBlocks 等共用函数
│
├── consolidation/              # 记忆整理子系统
│   ├── types.ts                # ScoreFactors、ScoredMemory、ConsolidationReport 等
│   ├── scorer.ts               # ImportanceScorer：五因子 + Ebbinghaus 衰减
│   ├── runner.ts               # ConsolidationRunner：dry-run + 实际执行 + dead-letter
│   ├── llm-consolidator.ts     # LLMConsolidator：边界区间调用任意 OpenAI-compat 端点
│   └── scheduler.ts            # ConsolidationScheduler：hourly tick + 状态持久化
│
├── backends/free-text/
│   ├── base.ts                 # FreeTextBackend 接口
│   ├── factory.ts              # 后端工厂（目前仅 mem0）
│   └── mem0.ts                 # mem0 platform + OSS 实现，Gemini/Kimi graph patch
│
├── classifier.ts               # UnifiedIntentClassifier：单次 LLM 分类，LRU 缓存
├── smart-router.ts             # SmartRouter：tier→model 映射
├── core-repository.ts          # CoreMemoryRepository：CRUD + 在线三元组去重
├── core-proposals.ts           # CoreProposalQueue：人工审核队列 + Regex 提取
├── core-admission.ts           # judgeCandidates()：批量 LLM 准入门控
├── candidate-queue.ts          # CandidateQueue：SHA256 去重 + 定时批处理
├── outbox.ts                   # OutboxWorker：指数退避重试 + 死信队列 + 磁盘持久化
├── sync.ts                     # MarkdownSync：定时写入 MEMORY.md
├── cache.ts                    # LRUCache<T>：带 TTL 的 LRU 缓存
├── inbound-cache.ts            # InboundMessageCache：入站消息去重辅助
├── metadata.ts                 # 分词 + 中文数字归一化 + 语义重排序 + trigram 相似度
├── security.ts                 # shouldCapture / escapeForInjection / 注入检测
├── workspace-facts.ts          # 工作区 MD 文件 fallback 检索
├── metrics.ts                  # 运行时指标（召回延迟、捕获量等）
├── llm-config.ts               # Kimi/Gemini API 地址归一化工具
├── cli.ts                      # /memu 所有 CLI 命令实现
│
├── tools/                      # 9 个 Agent 工具（工厂模式）
│   ├── recall.ts               # memory_recall
│   ├── store.ts                # memory_store
│   ├── forget.ts               # memory_forget
│   ├── stats.ts                # memory_stats
│   ├── core-list.ts            # memory_core_list
│   ├── core-upsert.ts          # memory_core_upsert
│   ├── core-delete.ts          # memory_core_delete
│   ├── core-touch.ts           # memory_core_touch
│   └── core-proposals.ts       # memory_core_proposals
│
├── scripts/
│   ├── real-data-analysis.ts   # 真实数据干跑分析（评分分布 + 整理报告）
│   └── tune-params.ts          # 参数调优诊断（跑满一周后使用）
│
└── tests/                      # 测试文件（npx tsx 运行）
    ├── consolidation-scorer.test.ts
    ├── consolidation-runner.test.ts
    ├── consolidation-e2e.test.ts
    ├── e2e-lifecycle.test.ts
    ├── cache.test.ts
    ├── classifier.test.ts
    └── ...
```

---

## 5. 核心模块详解

### 5.1 双轨记忆体系

#### Core Memory（核心记忆）

本地 JSON 文件存储的结构化 KV，零网络依赖，毫秒级访问。

**数据结构：**

```typescript
type CoreMemoryRecord = {
  id: string;           // UUID
  category: string;     // identity / goals / preferences / constraints / relationships / technical / general
  key: string;          // 格式：category.topic，如 identity.name
  value: string;        // 简洁事实陈述
  importance?: number;  // 重要性，0–10（scorer 自动归一化为 0–1）
  tier?: "profile" | "technical" | "general";
  source?: string;      // 来源：capture-queue / capture-llm-gate / manual 等
  createdAt?: number;
  updatedAt?: number;
  touchedAt?: number;   // 最近一次被注入/访问的时间（影响整理评分）
};
```

**Tier 策略：**

| Tier | Category 映射 | 注入方式 |
|------|-------------|---------|
| `profile` | identity / preferences / goals / relationships | 永远注入（always-inject） |
| `general` | constraints 及其他 | 永远注入 |
| `technical` | technical / architecture / decision / benchmark | 按评分检索时注入 |

**持久化路径：** `~/.openclaw/data/memory-mem0/core-memory.json`

#### Free-text Memory（自由文本记忆）

通过 mem0 OSS 模式存储于向量数据库（Qdrant + bge-m3 1024维嵌入），支持语义相似度检索。

**memory_kind 分类：**

| 类型 | 触发关键词示例 |
|------|-------------|
| `profile` | 名字、时区、住在 |
| `preference` | 喜欢、偏好 |
| `constraint` | 必须、禁止、不要 |
| `goal` | 目标、计划 |
| `decision` | 决定、选择、因为 |
| `architecture` | 架构、分层、管线 |
| `technical` | 配置、参数、模型 |
| `benchmark` | 延迟、成本、p95 |
| `lesson` | 教训、复盘、经验 |
| `workflow` | 工作流、流程 |

---

### 5.2 召回管道（Recall Hook）

**触发时机：** `before_prompt_build`，每次构建 Prompt 前自动执行。

**执行流程：**

```
1. 查询提取
   raw prompt/messages
     ├── stripInjectedBlocks()      去除上次注入的 <core-memory>/<relevant-memories>
     ├── stripPromptLead()          去除飞书/时间元数据前缀
     ├── sanitizePromptQuery()      提取最后一条用户文本
     └── splitRecallQueries()       拆分多问题（按序号、分号、换行）

2. 意图分类（UnifiedIntentClassifier）
   → 返回 queryType / captureHint / targetCategories / tier

3. 双层检索（并行）
   Phase 1: always-inject 池
     全量 Core Memory 按 tier=profile/general 筛选，全量注入

   Phase 2: technical tier 检索
     scoreCoreCandidate() 多维评分：
       ├── 精确 key 匹配 = 1.0～1.2
       ├── token overlap BM25
       ├── conceptBoost（同义词/概念扩展）
       └── categoryBoost（+0.12 当 category 命中意图）

   Phase 3: free-text 向量检索
     mem0.search() × queryParts 并行 → 去重 → rerankMemoryResults() 重排序

   Phase 4: workspace facts（并行补充）
     工作区 MD 文件 token 匹配，本地 fallback

4. 注入 Prompt
   <core-memory>
   稳定事实，优先级高于 relevant-memories...
   1. 候选答案 [identity/identity.name]：昊。
   </core-memory>

   <relevant-memories>
   补充历史事实...
   1. 候选答案 [general]：用户上午和晚上最高效。
   </relevant-memories>
```

**会话级去重：**

| 去重机制 | TTL | 说明 |
|---------|-----|------|
| 注入签名去重 | 30s | 相同内容短期内不重复注入 |
| Session Core Cache | 90s | 同 session Core 列表复用 |
| Session Relevant Cache | 90s | 相同语义查询 free-text 结果复用 |

---

### 5.3 统一意图分类器

单次 LLM 调用（Kimi Coding k2p5），结果缓存在 LRU Cache（300s TTL），同一查询只调用一次。

**分类维度：**

| 字段 | 取值 | 用途 |
|------|------|------|
| `tier` | SIMPLE / MEDIUM / COMPLEX / REASONING | 可选模型路由（Smart Router） |
| `queryType` | greeting / code / debug / factual / preference / planning / open | 控制捕获策略 |
| `captureHint` | skip / light / full | 控制 Capture Pipeline 行为 |
| `targetCategories` | identity / work / preferences / goals… | 引导 Core Memory 检索范围 |

**captureHint 行为：**

| captureHint | 处理方式 |
|-------------|---------|
| `skip` | 完全跳过捕获（问候、纯代码请求、调试） |
| `light` | 仅写 free-text，跳过 Core LLM Gate |
| `full` | 完整处理：Regex 提取 + LLM Gate + Outbox |

---

### 5.4 捕获管道（Capture Pipeline）

**唯一自动捕获入口：`agent_end`**（仅当 `event.success=true` 时执行）。

```
agent_end
  │
  ├── 提取对话窗口（最近 maxConversationTurns 个 user 轮次）
  ├── stripInjectedBlocks()   清除注入的 memory block
  ├── shouldCapture() 过滤：
  │     ├── 内容 < minChars(20) 或 > maxChars(600)
  │     ├── 命中低信号模式（"好的"、"测试"、"今天"等）
  │     ├── 命中系统片段前缀（[system]、[tool_result]…）
  │     └── 与最近捕获相似度 ≥ dedupeThreshold(0.8)
  │
  └── 入队 CandidateQueue（enabled=true）
      或直接写 Outbox（enabled=false）

CandidateQueue 批处理（默认每 10s，最多 50 条）
  │
  ├── 路由到 Outbox（free-text 写入）
  │
  ├── Regex 快速提取 Core（高置信度模式）
  │     "我叫X" / "我来自X" / "我喜欢X" 等
  │     → humanReviewRequired=true  → ProposalQueue
  │       humanReviewRequired=false → CoreRepo.upsert()
  │
  └── LLM Gate 批量判断（仅对 Regex 未命中 + captureHint=full 的项）
        返回 JSON 数组：[{index, verdict, key, value, reason}]
        ├── verdict=core      → CoreRepo.upsert() / ProposalQueue
        ├── verdict=free_text → 仅 Outbox（不写 Core）
        └── verdict=discard   → 完全丢弃
```

---

### 5.5 LLM 准入门控

`core-admission.ts` — 批量调用 LLM，对 CandidateQueue 中未被 Regex 捕获的项做三分类判断。

**System Prompt（中文）：**
- `core`：用户的稳定个人特征，必须提供 key（格式 `category.topic`）和 value
- `free_text`：有价值的上下文信息，可选提供 value 摘要
- `discard`：低信号/临时/闲聊内容，可省略不输出

**关键行为：**
- 需要 `llmGate.apiKey` 才生效；无 key 时静默跳过（仅 Regex 路径）
- 使用模块级 inflight Map 去重：相同 batch 内容不会并发发两次
- 响应解析容错：支持 markdown 代码块、截断 JSON

---

### 5.6 Outbox 异步写回队列

解耦 AI 主流程与 mem0 写入，不让网络延迟影响 Agent 响应速度。

| 特性 | 实现 |
|------|------|
| 磁盘持久化 | `outbox-queue.json`，重启后自动恢复 |
| 去重 | 1分钟时间桶 SHA256 哈希 |
| 重试策略 | 指数退避：1s → 5s → 30s → 120s |
| 死信队列 | 超过 maxRetries(5) 后移入 `outbox-deadletter.json` |
| 并发控制 | 并发度 2，批量 10 |
| 立即刷新 | enqueue 后立即触发一次 flush（减少写入延迟） |
| 优雅停机 | `drain(drainTimeoutMs)` 保证消息不丢 |

---

### 5.7 记忆整理系统（Consolidation）

后台独立子系统，定期评估 Core Memory 的重要性并做保留/降级/归档/删除决策。

#### 调度器（ConsolidationScheduler）

每小时 tick，按墙钟时间判断是否触发：

| 周期 | 默认时间 | 说明 |
|------|---------|------|
| `daily` | 每天 03:00 | 轻量清理 |
| `weekly` | 每周一 04:00 | 中度整合 |
| `monthly` | 每月1日 05:00 | 深度审查 |

- 状态持久化到 `consolidation-state.json`，重启不重复触发
- inflight Map 保证同一周期不并发执行
- 支持 `/memu consolidate run <cycle>` 手动触发

#### 五因子重要性评分（ImportanceScorer）

```
score = recency × 0.30
      + accessFreq × 0.20
      + novelty × 0.20
      + typePrior × 0.15
      + explicitImportance × 0.15
```

| 因子 | 计算方式 |
|------|---------|
| `recency` | Ebbinghaus 遗忘曲线：`e^(-Δt/S)`，S=stabilityDays(14天) |
| `accessFreq` | (touchedAt − createdAt) 相对集合中位数的 sigmoid 归一化 |
| `novelty` | 1 − max(trigram 相似度，同 category 其他记录) |
| `typePrior` | 静态先验：profile=1.0，technical=0.8，general=0.5 |
| `explicitImportance` | importance 字段，自动归一化（>1 则 ÷10）|

#### 分级裁决阈值

| 分数区间 | 裁决 | 行为 |
|---------|------|------|
| ≥ 0.65 | `keep` | 保留不变 |
| [0.45, 0.65) | `downgrade` | 降级（降低 tier/importance） |
| [0.25, 0.45) | `archive` | 归档标记，跳过注入但不删除 |
| [0.10, 0.25) | `archive` | 同上 |
| < 0.10 | `delete` | 写 dead-letter 后删除 |
| [0.35, 0.55] | `llm-boundary` | 在上述基础上额外调用 LLM 精细裁决 |

#### LLM 边界裁决

处于 llmLow–llmHigh（默认 0.35–0.55）区间的记录，调用 LLM 做精细判断。支持任意 OpenAI-compatible 端点：

```jsonc
"consolidation": {
  "llm": {
    "enabled": true,
    "apiBase": "http://localhost:11434/v1",  // 本地 Ollama
    // 或 "https://api.kimi.com/coding/v1" / "https://api.openai.com/v1"
    "model": "qwen2.5:7b",
    "timeoutMs": 30000,
    "maxBatchSize": 20
  }
}
```

#### Dead-letter 保护

删除前将被删记录完整写入 `consolidation-dead-letter.jsonl`（JSONL 追加），包含完整记录内容、删除原因、删除时间戳。误删可从文件中手动恢复。

#### 参数调优

跑满一周后运行诊断脚本：

```bash
npx tsx scripts/tune-params.ts
```

输出：评分分布直方图、bimodality 检测、Ebbinghaus 衰减充分性估算、LLM 边界率、dead-letter 质量分析、因子方差诊断，并给出具体配置建议。

---

### 5.8 Markdown 同步

`MarkdownSync` 将 Core Memory 写入 MEMORY.md，使 Agent 启动读取文件时可直接感知记忆。

| 触发方式 | 间隔 |
|---------|------|
| 定时同步 | 每 5 分钟（`sync.intervalMs=300000`） |
| 写入后触发 | 捕获写入后 1s 防抖 |

**输出格式：**

```markdown
<!-- memory-mem0:start -->
<!-- memory-mem0:generated -->
<!-- scope:user=hao.break.zero agent=turning_zero -->

## Core Identity
- [identity/identity.name] 昊，北京，UTC+8

## Core Goals & Constraints
- [goals/goals.primary] 成为一人公司创业者

## Recent Context
- 用户主要深耕分布式系统与高并发。

<!-- memory-mem0:end -->

## Manual Notes
（用户手工维护的内容，同步时不覆盖）
```

---

### 5.9 安全机制

#### 注入攻击防御

写入 Core Memory 前均通过 `shouldStoreCoreMemory()` 校验：
- key 格式：`/^[a-z0-9][a-z0-9_.-]{1,79}$/`
- value 最大长度截断
- 13 个注入模式检测（`ignore all previous instructions`、`you are now`、`jailbreak` 等）

#### 敏感信息过滤

自动拦截：中国手机号、美国电话、电子邮件、中国身份证、SSN、API Key（sk-/pk-/rk- 前缀）。

#### XML 转义

所有注入到 Prompt 的记忆文本均经过 `escapeForInjection()` 处理，防止特殊字符破坏 XML 结构。

---

## 6. 配置参考

### 最小配置

```jsonc
{
  "plugins": {
    "entries": {
      "memory-mem0": {
        "enabled": true,
        "config": {
          "dataDir": "~/.openclaw/data/memory-mem0",
          "kimiApiKey": "YOUR_KIMI_CODING_API_KEY",
          "mem0": {
            "mode": "open-source",
            "oss": {
              "llm": {
                "provider": "kimi_coding",
                "config": { "model": "k2p5" }
              },
              "embedder": {
                "provider": "ollama",
                "config": { "model": "bge-m3:latest", "embeddingDims": 1024 }
              },
              "vectorStore": {
                "provider": "qdrant",
                "config": { "host": "localhost", "port": 6333 }
              }
            }
          },
          "scope": { "userId": "your-user-id" }
        }
      }
    }
  }
}
```

### 完整配置

```jsonc
{
  "dataDir": "~/.openclaw/data/memory-mem0",   // 统一数据目录（替代多个 persistPath 字段）
  "kimiApiKey": "YOUR_KEY",                     // 共享 API Key，classifier/llmGate/mem0 均继承

  "mem0": {
    "mode": "open-source",       // "platform" 使用 mem0 云服务
    "enableGraph": false,        // 开启 Neo4j 图谱记忆（需额外配置）
    "searchThreshold": 0.3,
    "topK": 5,
    "customInstructions": "",    // 写入 mem0 时的额外指令
    "oss": {
      "embedder":   { "provider": "ollama",      "config": { "model": "bge-m3:latest", "embeddingDims": 1024 } },
      "vectorStore":{ "provider": "qdrant",      "config": { "host": "localhost", "port": 6333 } },
      "llm":        { "provider": "kimi_coding", "config": { "model": "k2p5" } },
      "historyDbPath": "~/.openclaw/data/memory-mem0/memory.db"
    }
  },

  "scope": {
    "userId": "your-user-id",
    "agentId": "main",
    "userIdByAgent": {            // 多 Agent 使用不同 userId
      "agent_a": "user_a",
      "agent_b": "user_b"
    }
  },

  "recall": {
    "enabled": true,
    "topK": 5,
    "threshold": 0.25,           // 召回阈值（bge-m3 对短句偏低，建议 0.20–0.25）
    "maxChars": 1500,            // Prompt 注入字符预算
    "cacheTtlMs": 60000,
    "cacheMaxSize": 100
  },

  "core": {
    "enabled": true,
    "topK": 10,
    "maxItemChars": 300,
    "autoExtractProposals": true,
    "humanReviewRequired": false, // true 时所有 Core 候选需人工审核
    "touchOnRecall": true,        // 被注入时更新 touchedAt（影响整理评分）
    "alwaysInjectTiers": ["profile", "general"],
    "alwaysInjectLimit": 800,     // always-inject 字符上限

    "consolidation": {
      "enabled": true,
      "intervalMs": 3600000,      // 最短整理间隔（防止高频重跑）
      "similarityThreshold": 0.85,// 在线合并去重阈值

      "weights": {
        "recency": 0.30, "accessFreq": 0.20, "novelty": 0.20,
        "typePrior": 0.15, "explicitImportance": 0.15
      },
      "decay": { "stabilityDays": 14 },

      "thresholds": {
        "keep": 0.65, "downgrade": 0.45, "archive": 0.25, "delete": 0.10,
        "llmLow": 0.35, "llmHigh": 0.55
      },

      "schedule": {
        "daily":   { "enabled": true, "hourOfDay": 3 },
        "weekly":  { "enabled": true, "hourOfDay": 4, "dayOfWeek": 1 },
        "monthly": { "enabled": true, "hourOfDay": 5, "dayOfMonth": 1 }
      },

      "llm": {
        "enabled": false,                        // 默认关闭，需手动开启
        "apiBase": "http://localhost:11434/v1",   // 任意 OpenAI-compat 端点
        "model": "qwen2.5:14b",
        "timeoutMs": 30000,
        "maxBatchSize": 20
      }
    },

    "llmGate": {
      "enabled": false,           // 开启后对 Regex 未命中的候选做 LLM 三分类
      "apiBase": "https://api.kimi.com/coding/",
      "model": "k2p5",
      "maxTokensPerBatch": 4000,
      "timeoutMs": 60000
      // apiKey 继承自 kimiApiKey
    }
  },

  "capture": {
    "enabled": true,
    "minChars": 20,
    "maxChars": 600,
    "maxConversationTurns": 6,    // 建议 3–4，避免窗口过长
    "dedupeThreshold": 0.8,
    "candidateQueue": {
      "enabled": true,
      "intervalMs": 10000,        // 批处理间隔（ms）
      "maxBatchSize": 50
    }
  },

  "outbox": {
    "enabled": true,
    "concurrency": 2,
    "batchSize": 10,
    "maxRetries": 5,
    "drainTimeoutMs": 5000,
    "flushIntervalMs": 10000
  },

  "sync": {
    "enabled": true,
    "intervalMs": 300000,
    "memoryFilePath": "MEMORY.md"  // 相对于 agent workspace 的路径
  },

  "classifier": {
    "enabled": true,
    "model": "k2p5",
    "apiBase": "https://api.kimi.com/coding/",
    "cacheTtlMs": 300000,
    "cacheMaxSize": 200
    // apiKey 继承自 kimiApiKey
  },

  "smartRouter": {
    "enabled": false,             // 开启后按复杂度层级路由模型
    "tierModels": {
      "SIMPLE": "gemini-2.0-flash-lite",
      "MEDIUM": "gemini-2.5-flash",
      "COMPLEX": "gemini-2.5-pro",
      "REASONING": "claude-sonnet-4-6"
    }
  }
}
```

### 常见调优建议

| 场景 | 参数 | 建议值 |
|------|------|--------|
| 中文召回准确率低 | `recall.threshold` | 0.20–0.25 |
| 记忆噪音多 | `core.llmGate.enabled` | `true` |
| 人工控制写入 | `core.humanReviewRequired` | `true` |
| 捕获窗口过长 | `capture.maxConversationTurns` | 3–4 |
| 整理过于激进 | `consolidation.decay.stabilityDays` | 增大（如 21） |
| 整理不够及时 | `consolidation.decay.stabilityDays` | 减小（如 7–10） |
| LLM 裁决太多 | `consolidation.thresholds.llmLow/High` | 收窄区间 |

---

## 7. 工具 API

| 工具 | 说明 |
|------|------|
| `memory_recall` | 手动触发语义检索 |
| `memory_store` | 显式存储一条 free-text 记忆 |
| `memory_forget` | 删除指定记忆 |
| `memory_stats` | 查看运行状态（召回延迟、捕获量、队列状态） |
| `memory_core_list` | 列出 Core Memory |
| `memory_core_upsert` | 手动写入/更新 Core Memory |
| `memory_core_delete` | 删除 Core Memory 条目 |
| `memory_core_touch` | 刷新记录访问时间（防止被整理淘汰） |
| `memory_core_proposals` | 审核 LLM 提取的候选记忆 |

**示例：**

```
// 手动写入
memory_core_upsert(
  category="goals", key="goals.2026_q1",
  value="2026年Q1完成iOS应用MVP并上架AppStore",
  importance=8
)

// 审核提案
memory_core_proposals(action="list")
memory_core_proposals(action="approve", proposalId="xxx")
memory_core_proposals(action="reject",  proposalId="xxx")
```

---

## 8. CLI 命令（/memu）

### 基础命令

| 命令 | 说明 |
|------|------|
| `/memu status` | 插件运行状态（outbox、core、recall 统计） |
| `/memu search <query>` | 手动语义搜索 |
| `/memu flush` | 立即刷新 outbox 队列 |
| `/memu dashboard` | 完整指标看板 |
| `/memu audit` | 审计日志 |
| `/memu core list` | 列出 Core Memory |
| `/memu core touch <id>` | 刷新访问时间 |

### 整理系统命令

| 命令 | 说明 |
|------|------|
| `/memu consolidate status` | 查看调度状态（上次运行时间、总次数、最近报告） |
| `/memu consolidate run [cycle]` | 立即执行整理（daily/weekly/monthly，默认 daily） |
| `/memu consolidate run [cycle] --dry-run` | 干跑预览，不修改数据 |
| `/memu consolidate report [n]` | 查看最近 n 条整理报告（默认 5） |

**干跑示例输出：**

```
🧹 Consolidation dry-run (daily) — 82 records scored
  keep      (≥0.65): 61
  downgrade (≥0.45):  8
  archive   (≥0.25):  9
  delete    (<0.10):  4
  llm-boundary:       6 → would call LLM

  Would DELETE:
    [general/memu_server.monthly_cost] score=0.041 — 月费用 0 美元
    reason: very low score (0.041 < 0.10)
```

---

## 9. 作用域隔离（Scope）

所有操作通过 `MemoryScope` 隔离：

```typescript
type MemoryScope = {
  userId: string;     // 用户维度
  agentId: string;    // Agent 维度（从 sessionKey 自动推断）
  sessionKey: string; // 会话维度
  tenantId?: string;  // 租户维度（可选）
};
```

**多 Agent 隔离：**
- Core Memory 按 `(userId, agentId)` 过滤
- free-text 检索传入完整 scope，mem0 按 userId+agentId 隔离向量空间
- `scope.userIdByAgent` 支持不同 Agent 映射到不同 userId

**运行时推断：**

```
ctx.agentId（来自运行时） > sessionKey 解析（"agent:xxx:main"）> 配置值
```

---

## 10. 数据文件

所有文件默认在 `~/.openclaw/data/memory-mem0/`：

| 文件 | 内容 | 说明 |
|------|------|------|
| `core-memory.json` | Core Memory 主存储 | 直接可读 JSON，可手动编辑 |
| `outbox-queue.json` | 待发送队列 | 异常时可手动清空 |
| `outbox-deadletter.json` | Outbox 死信 | 需人工介入 |
| `candidate-queue.json` | 捕获候选缓冲 | 批处理前的暂存 |
| `core-proposals.json` | 人工审核队列 | humanReviewRequired=true 时使用 |
| `consolidation-dead-letter.jsonl` | 整理删除记录 | JSONL，每行一条被删记录，可用于误删恢复 |
| `consolidation-state.json` | 整理调度状态 | lastDailyRun / lastWeeklyRun / lastMonthlyRun |
| `memory.db` | mem0 SQLite 历史库 | mem0 OSS 内部使用 |
| `inbound-message-cache.json` | 入站消息缓存 | 辅助捕获去重 |
| `MEMORY.md`（workspace） | Markdown 同步输出 | Agent 启动时直接读取 |

---

## 11. FAQ

**Q: 为什么有些内容没有被自动记忆？**

捕获过滤掉以下情况：内容 < 20 字符 / > 600 字符；命中低信号模式（"好的"、"测试"、"今天"等）；含系统片段前缀；与最近捕获的内容相似度 ≥ 0.8；captureHint=skip（问候/纯代码等）。

**Q: LLM Gate 不工作？**

检查 `core.llmGate.enabled=true` 且 `llmGate.apiKey` 已配置（或 `kimiApiKey` 已设置）。无 apiKey 时静默跳过。

**Q: Core Memory 会越来越多吗？**

不会无限增长。整理调度器定期淘汰低分记忆；在线三元组去重会合并重复写入。建议跑一周后运行 `npx tsx scripts/tune-params.ts` 查看评分分布，视情况调整 `stabilityDays`。

**Q: 整理系统会误删重要记忆吗？**

删除前会写入 `consolidation-dead-letter.jsonl`，可手动恢复。建议先用 `--dry-run` 预览。

**Q: 整理 LLM 必须用 Qwen/Ollama 吗？**

不是，支持任意 OpenAI-compatible 端点。配置 `core.consolidation.llm.apiBase` 和 `model` 即可。不配置 LLM（`enabled=false`）也完全可用，仅用阈值裁决。

**Q: 整理跑了但没有删除任何记忆？**

正常现象。新鲜记忆的 recency 评分偏高（Ebbinghaus 衰减需要时间），通常需要 2–3 周才开始出现删除。运行 `npx tsx scripts/tune-params.ts` 可估算首次删除发生时间。

**Q: 多个 Agent 的记忆会互相影响吗？**

不会。Core Memory 和 free-text 检索均按 `(userId, agentId)` 隔离。如需多 Agent 共享同一用户记忆，将多个 agentId 映射到同一 userId 即可（`scope.userIdByAgent`）。

**Q: mem0 OSS 报错 "unable to open database file"？**

检查 `dataDir` 父目录是否存在且可写。`historyDbPath` 会自动展开 `~`。

**Q: 启用 Graph Memory 时 LLM 认证失败？**

推荐直接在 `oss.llm` 配置 `kimi_coding` provider，插件会自动将 Kimi/Gemini provider 改写为 OpenAI-compatible 格式传给 mem0，通常不需要单独配置 `oss.graph_store.llm`。

---

> 基于 memory-mem0 v1.1.0 源码 · 最后更新 2026-03-22
