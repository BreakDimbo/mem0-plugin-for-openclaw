# memory-mem0 插件技术文档

> 版本 v1.0.0 · 2026-03-16 · 基于源码深度分析

---

## 1. 项目概述

`memory-mem0` 是 OpenClaw 的**增强型记忆插件**，为 AI Agent 提供跨会话的长期记忆能力。它将非结构化对话内容转化为结构化的持久知识，在下次会话时精准召回，使 Agent 在每次对话中都能感知用户的历史偏好、目标与约束。

### 核心能力

| 能力 | 描述 |
| --- | --- |
| **双轨记忆** | Core Memory（结构化 KV）+ Free-text Memory（向量语义） |
| **异步捕获** | 对话结束后静默提取，不干扰主流程 |
| **混合检索** | 向量召回 + BM25 关键词，支持中文 |
| **LLM 准入门控** | 批量 LLM 判断候选记忆质量，防止噪音写入 |
| **Tier 分层注入** | profile/general 层永久注入，technical 层按需检索 |
| **安全防护** | 注入攻击检测、敏感信息过滤、XML 转义 |
| **Markdown 同步** | 核心记忆定期写入 MEMORY.md，跨会话可读 |

---

## 2. 系统架构

### 2.1 整体流程图

```
用户消息
    │
    ▼
[message_received 钩子]
    │── 低信号过滤 ──► 丢弃
    │── 长度校验
    │── shouldCapture()
    └── 加入 CandidateQueue ──────────────────────────────┐
                                                          │ 批量定时（默认10min）
[before_prompt_build 钩子]                                ▼
    │                                            [CandidateQueue 批处理]
    ├── 提取查询意图（inferQueryIntent）               │
    ├── Core Memory 检索                              ├── 写入 Outbox（free-text）
    │   ├── always-inject 池（profile + general）     ├── Regex 快速提取 core 候选
    │   └── retrieval 池（technical，按评分）         └── LLM Gate 批量判断（regex 未命中）
    ├── Free-text 向量检索（mem0 + 工作区）                │
    │   └── 重排序 + 截断                              ├── verdict=core → CoreRepo.upsert()
    └── 注入上下文                                     ├── verdict=free_text → Outbox
        ├── <core-memory>...</core-memory>             └── verdict=discard → 丢弃
        └── <relevant-memories>...</relevant-memories>
                                                  [OutboxWorker]
[agent_end 钩子]                                      │── 指数退避重试（1s/5s/30s/120s）
    │── 提取最后一条用户消息                            │── 并发度 2，批量 10
    └── 转发到 CandidateQueue（fallback）              └── 死信队列（超过 maxRetries）

                                                  [MarkdownSync]
                                                      │── 每 5 分钟定时同步
                                                      └── 写入 MEMORY.md（按 agent 隔离）
```

### 2.2 模块结构

```
memory-mem0/
├── index.ts              # 插件入口，注册所有模块
├── types.ts              # 类型定义 + 配置 Schema + 默认值
├── hooks/
│   ├── recall.ts         # before_prompt_build：召回 + 注入
│   ├── capture.ts        # agent_end：捕获兜底
│   └── message-received.ts  # 实时消息过滤 + 入队
├── core-repository.ts    # Core Memory CRUD + 合并去重
├── core-proposals.ts     # 人工审核队列
├── core-admission.ts     # LLM 准入门控
├── outbox.ts             # 异步写回队列
├── candidate-queue.ts    # 捕获候选缓冲
├── sync.ts               # Markdown 同步
├── security.ts           # 注入防御 + 敏感过滤
├── metadata.ts           # 记忆类型推断 + 重排序
├── cache.ts              # LRU 缓存
├── inbound-cache.ts      # 入站消息缓存（辅助召回）
├── workspace-facts.ts    # 工作区文件检索 fallback
└── backends/
    └── free-text/
        ├── base.ts       # FreeTextBackend 接口
        ├── mem0.ts       # mem0 向量数据库实现
        └── factory.ts    # 后端工厂
```

---

## 3. 核心模块详解

### 3.1 双轨记忆体系

#### Core Memory（核心记忆）

结构化 KV 存储，持久化在本地 JSON 文件中。

**数据结构：**

```typescript
type CoreMemoryRecord = {
  id: string;            // UUID
  category: string;      // identity / goals / constraints / preferences / relationships / general
  key: string;           // 格式：category.topic（如 identity.name）
  value: string;         // 简洁的第三人称事实陈述
  importance?: number;   // 重要性 1-10
  tier?: CoreMemoryTier; // profile | technical | general
  source?: string;       // 来源标识
  createdAt: number;
  updatedAt: number;
  touchedAt?: number;    // 最近一次被注入/访问的时间
};
```

**Tier 分层策略：**

| Tier | Category 映射 | 注入策略 |
| --- | --- | --- |
| `profile` | identity / preferences / goals / relationships | 永远注入（always-inject） |
| `technical` | technical / architecture / decision / benchmark | 仅按评分检索时注入 |
| `general` | 其他（constraints 等） | 永远注入 |

**存储路径：** `~/.openclaw/data/memory-memu/core-memory.json`

#### Free-text Memory（自由文本记忆）

向量数据库存储，通过 mem0（OSS 模式）实现语义检索。

**元数据类型体系：**

| memory_kind | 触发关键词示例 | 描述 |
| --- | --- | --- |
| `profile` | 名字、时区、住在 | 身份基础信息 |
| `preference` | 喜欢、偏好 | 个人偏好 |
| `constraint` | 必须、禁止、不要 | 规则与约束 |
| `goal` | 目标、计划、方向 | 长期目标 |
| `relationship` | 伴侣、同事、朋友 | 关系信息 |
| `decision` | 决定、选择、因为 | 决策与理由 |
| `architecture` | 架构、分层、管线 | 系统设计 |
| `technical` | 配置、参数、模型 | 技术细节 |
| `benchmark` | 延迟、成本、p95 | 性能指标 |
| `lesson` | 教训、复盘、经验 | 学习成果 |
| `workflow` | 工作流、代码审查 | 流程信息 |
| `project` | 项目、工作区、文档 | 项目上下文 |
| `general` | 其他 | 通用 |

**Quality 分级：**

- `durable`：稳定持久事实（偏好、约束、目标）→ Markdown 同步优先
- `transient`：临时上下文 → 检索后不持久同步

---

### 3.2 召回管道（Recall Hook）

**触发时机：** `before_prompt_build`（每次 Agent 构建 Prompt 前）

**查询提取策略：**

```
raw prompt / messages
    │
    ├── stripInjectedBlocks()     # 去除上次注入的 <core-memory>
    ├── stripPromptLead()         # 去除 Feishu/time 元数据前缀
    ├── sanitizePromptQuery()     # 提取最后一条用户文本
    └── splitRecallQueries()      # 拆分多问题（按序号、分号、换行）
```

**查询意图推断（inferQueryIntent）：**

插件会分析查询关键词，推断用户意图并选择最优检索策略：
- `singleFact`：是否是单点查询（影响返回条数）
- `configLike`：是否是技术配置类问题（限制 free-text 返回 2 条）
- `categoryHints`：推断相关 category（identity / constraints / technical 等）

**双层检索：**

```
Phase 1: always-inject 池（profile + general tier）
  └── 全量 Core Memory 按 tier 筛选，永远注入

Phase 2: retrieval 池（technical tier）
  └── scoreCoreCandidate() 评分：
      ├── 精确匹配 = 1.0 ~ 1.2
      ├── tokenOverlap BM25 = 0 ~ 0.99
      ├── conceptBoost（同义词/概念扩展）
      └── categoryBoost（+0.12 当 category 命中意图）

Phase 3: Free-text 向量检索
  └── mem0.search() × queryParts 并行
      └── 去重 + rerankMemoryResults() 重排序

Phase 4: workspace facts（并行补充）
  └── 搜索工作区 MD 文件，补充本地上下文
```

**注入格式：**

```xml
<core-memory>
稳定事实，优先级高于 relevant-memories...

1. 候选答案 [identity/identity.name]：用户叫昊。
2. 候选答案 [goals/goals.primary]：用户的主目标是成为一人公司创业者。
</core-memory>

<relevant-memories>
补充历史事实。仅当 core-memory 没覆盖答案时再参考...

1. 候选答案 [general]：用户上午和晚上最高效...
</relevant-memories>
```

**注入去重机制：**

- **签名去重**：相同内容在 30s 内不重复注入
- **Session Core Cache**：90s 内同一 session 的 Core 列表复用
- **Session Relevant Cache**：90s 内相同语义查询的 free-text 结果复用

---

### 3.3 捕获管道（Capture Pipeline）

**三层入口，确保不遗漏：**

| 入口 | 触发时机 | 说明 |
| --- | --- | --- |
| `message_received` | 用户消息到达时（主路径） | 最快，实时入队 |
| `recall hook` | 构建 Prompt 时 | 仅处理最后一条用户消息 |
| `agent_end` | Agent 回复完成后（兜底） | CandidateQueue 哈希去重 |

**过滤条件（任一命中即丢弃）：**

```typescript
// 1. 系统片段
SKIP_PREFIXES = ["[system]", "[tool_result]", "<system", "```tool"]

// 2. 长度校验
text.length < minChars(16) || text.length > maxChars(600)

// 3. 低信号内容
LOW_SIGNAL_PATTERNS = [
  /ok|好的|嗯|收到/,          // 简短确认
  /today|明天|今天|今晚/,      // 临时时间表达
  /test|debug|memu|测试/,    // 调试内容
]

// 4. 相似度去重（三元组相似度 >= 0.8）
trigramSimilarity(text, recent) >= dedupeThreshold
```

#### CandidateQueue 批处理流程

```
入队（enqueue）
    │── SHA256 哈希去重（全局 200 条窗口）
    └── 写入 candidate-queue.json（持久化）

定时触发（默认 10 分钟）
    │
    ▼
processBatch（最多 50 条）
    │
    ├── 路由到 Outbox（free-text 写入）
    │
    ├── Regex 快速提取核心候选
    │   └── extractCoreProposal()：
    │       识别"用户叫X"/"我来自X"等高置信度模式
    │       └── humanReviewRequired=true → ProposalQueue
    │           humanReviewRequired=false → CoreRepo.upsert()
    │
    └── LLM Gate 批量判断（regex 未命中项）
        ├── 调用 Gemini Flash Lite（或配置模型）
        ├── 返回 JSON：verdict / key / value / reason
        └── verdict=core → CoreRepo.upsert()
            verdict=free_text → 已写入 Outbox
            verdict=discard → 丢弃
```

#### LLM Gate System Prompt

LLM Gate 使用中文 System Prompt 进行三分类判断：

- **core**：用户稳定个人特征（必须提供 key + value）
- **free_text**：有价值的上下文信息
- **discard**：低信号/临时/闲聊内容

**注意：LLM Gate 需要 `llmGate.apiKey` 配置，否则静默跳过。**

---

### 3.4 Outbox 异步写回队列

**设计目标：** 解耦 AI 主流程与外部 mem0 写入，不让网络延迟影响响应速度。

**关键特性：**

| 特性 | 实现 |
| --- | --- |
| **持久化** | 写入 `outbox-queue.json`，重启恢复 |
| **去重** | 1分钟时间桶 SHA256 哈希 |
| **指数退避** | 1s → 5s → 30s → 120s |
| **死信队列** | maxRetries（默认5次）后移入 `outbox-deadletter.json` |
| **并发控制** | 并发度 2，批量 10 |
| **立即刷新** | enqueue 后立即触发一次 flush（减少延迟） |
| **优雅停机** | drain(drainTimeoutMs) 保证消息不丢 |

**队列状态文件：**

```
~/.openclaw/data/memory-memu/
├── outbox-queue.json          # 待发送队列
├── outbox-deadletter.json     # 死信队列
├── candidate-queue.json       # 捕获候选
├── core-memory.json           # Core Memory 主存储
├── core-proposals.json        # 人工审核提案
└── mem0-vector-store.db       # 向量数据库
```

---

### 3.5 Core Memory 合并去重（Consolidation）

**触发时机：** CandidateQueue 批处理完成后，每小时最多触发一次。

**合并逻辑（两步）：**

**Step 1：精确键去重**

同 `(category, key)` 保留最新 `updatedAt` 的记录。

**Step 2：语义值去重**

同 category 内，用三元组相似度（trigramSimilarity）比较 value：
- 相似度 >= `similarityThreshold`（默认 0.85）则合并
- 保留 importance 更高的，相同则保留更新的

---

### 3.6 人工审核队列（CoreProposalQueue）

当 `humanReviewRequired: true` 时，LLM Gate 和 Regex 提取的核心记忆候选会进入审核队列，等待人工确认。

**操作接口：**

```
/memory_core_proposals list        # 查看待审核提案
/memory_core_proposals approve     # 批准（写入 CoreRepo）
/memory_core_proposals reject      # 拒绝
```

---

### 3.7 Markdown 同步（MarkdownSync）

**目的：** 将 Core Memory 写入 MEMORY.md，使其在 Agent 启动读取文件时可直接感知。

**同步策略：**

| 触发方式 | 间隔 |
| --- | --- |
| 定时同步 | 每 5 分钟（`flushIntervalSec`） |
| 按需触发 | 捕获写入后 1s 防抖延迟 |

**输出格式（写入 MEMORY.md）：**

```markdown
<!-- memory-mem0:start -->
<!-- memory-mem0:generated -->
<!-- scope:user=hao.break.zero agent=turning_zero session=... -->

## Core Identity
- [identity/identity.name] 用户叫昊。

## Core Goals & Constraints
- [goals/goals.primary] 用户的主目标是成为一人公司创业者。
- [constraints/constraints.turning_zero.external_action] turning_zero 对外部行动的默认要求是先确认。

## Recent Context
- 用户主要深耕分布式系统与高并发。

<!-- memory-mem0:end -->

## Manual Notes
（用户手工维护内容，同步时保留）
```

**注意：**

- 生成块与手动内容分离，不会覆盖手工维护的内容
- 支持多 Agent 各自同步到对应 workspace 的 MEMORY.md
- `quality=durable` 的 free-text 记忆优先进入 Recent Context

---

## 4. 安全机制

### 4.1 注入攻击防御

```typescript
// 检测并拦截以下模式：
INJECTION_PATTERNS = [
  /ignore all previous instructions/i,
  /you are now/i,
  /system:/i,
  /jailbreak/i,
  /DAN mode/i,
  // ... 共 13 个模式
]
```

所有即将写入 Core Memory 的内容都经过 `shouldStoreCoreMemory()` 校验：
1. Key 格式校验（`/^[a-z0-9][a-z0-9_.-]{1,79}$/`）
2. Value 最大长度截断
3. 注入模式检测
4. 敏感信息检测

### 4.2 敏感信息过滤

自动过滤以下内容：

| 类型 | 检测模式 |
| --- | --- |
| 中国手机号 | `1[3-9]\d{9}` |
| 美国电话 | `\d{3}[-.]?\d{3}[-.]?\d{4}` |
| 电子邮件 | `[\w.-]+@[\w.-]+\.\w{2,}` |
| 中国身份证 | 18位标准格式 |
| SSN | `\d{3}-\d{2}-\d{4}` |
| API Key | `sk-/pk-/rk-` 前缀 |

### 4.3 上下文注入 XML 转义

所有注入到 Prompt 的记忆文本均经过 `escapeForInjection()` 处理，防止特殊字符破坏 XML 结构。

---

## 5. 配置参考

### 5.1 完整配置结构

```jsonc
{
  "plugins": {
    "entries": {
      "memory-mem0": {
        "enabled": true,
        "config": {
          "backend": {
            "freeText": { "provider": "mem0" }
          },
          "mem0": {
            "mode": "open-source",
            "enableGraph": false,
            "searchThreshold": 0.3,
            "topK": 5,
            "oss": {
              "embedder": {
                "provider": "ollama",
                "config": {
                  "url": "http://127.0.0.1:11434",
                  "model": "bge-m3:latest",
                  "embeddingDims": 1024
                }
              },
              "vectorStore": {
                "provider": "memory",
                "config": {
                  "collectionName": "memory-mem0",
                  "dimension": 1024,
                  "dbPath": "/path/to/mem0-vector-store.db"
                }
              },
              "llm": {
                "provider": "openai",
                "config": {
                  "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai/",
                  "model": "gemini-3.1-flash-lite-preview"
                }
              }
            }
          },
          "scope": {
            "userId": "hao.break.zero",
            "requireUserId": true,
            "requireAgentId": true
          },
          "recall": {
            "enabled": true,
            "method": "rag",
            "hybrid": {
              "enabled": true,   // 开启混合检索（推荐中文）
              "alpha": 0.6,
              "fallbackToRag": true
            },
            "topK": 8,
            "scoreThreshold": 0.25,
            "maxContextChars": 1500,
            "injectionBudgetChars": 1100,
            "cacheTtlMs": 60000,
            "cacheMaxSize": 100,
            "workspaceFallback": true
          },
          "core": {
            "enabled": true,
            "topK": 8,
            "maxItemChars": 240,
            "persistPath": "/path/to/data",
            "autoExtractProposals": true,
            "humanReviewRequired": false,
            "touchOnRecall": true,
            "proposalQueueMax": 200,
            "alwaysInjectTiers": ["profile", "general"],
            "retrievalOnlyTiers": ["technical"],
            "maxAlwaysInjectChars": 600,
            "consolidation": {
              "enabled": true,
              "intervalMs": 3600000,    // 1小时
              "similarityThreshold": 0.85
            },
            "llmGate": {
              "enabled": true,
              "apiBase": "https://generativelanguage.googleapis.com/v1beta/openai",
              "model": "gemini-3.1-flash-lite-preview",
              "maxTokensPerBatch": 2000,
              "timeoutMs": 30000
            }
          },
          "capture": {
            "enabled": true,
            "maxItemsPerRun": 3,
            "minChars": 16,
            "maxChars": 600,
            "dedupeThreshold": 0.8,
            "candidateQueue": {
              "enabled": true,
              "intervalMs": 600000,   // 10分钟
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
            "flushToMarkdown": true,
            "flushIntervalSec": 300,   // 5分钟
            "memoryFilePath": "MEMORY.md"
          }
        }
      }
    }
  }
}
```

### 5.2 配置优化建议

| 场景 | 参数 | 建议值 | 说明 |
| --- | --- | --- | --- |
| 中文召回准确率低 | `recall.scoreThreshold` | 0.20~0.25 | bge-m3 对短句分布偏低 |
| 记忆积累慢 | `capture.maxItemsPerRun` | 3~5 | 提升每轮捕获上限 |
| 记忆噪音多 | `llmGate.enabled` | true | 开启 LLM 质量门控 |
| 人工控制写入 | `humanReviewRequired` | true | 所有 core 候选需审核 |
| 多 Agent 隔离 | `scope.requireAgentId` | true | 默认已开启 |

---

## 6. 工具 API

### 6.1 可用工具列表

| 工具 | 功能 |
| --- | --- |
| `memory_recall` | 手动触发语义检索 |
| `memory_store` | 显式存储一条 free-text 记忆 |
| `memory_forget` | 删除指定记忆 |
| `memory_stats` | 查看运行状态（召回延迟、捕获量、队列状态） |
| `memory_core_list` | 列出 Core Memory |
| `memory_core_upsert` | 手动写入/更新 Core Memory |
| `memory_core_delete` | 删除 Core Memory 条目 |
| `memory_core_touch` | 刷新记忆的访问时间（防止被合并淘汰） |
| `memory_core_proposals` | 审核 LLM 提取的候选记忆 |

### 6.2 工具使用示例

**查看记忆状态：**

```
memory_stats() → 返回 Recall 延迟/Capture 量/Outbox 队列/Circuit Breaker 状态
```

**手动写入 Core Memory：**

```
memory_core_upsert(
  category="goals",
  key="goals.2026_q1",
  value="用户2026年Q1目标是完成iOS应用MVP并上架AppStore。",
  importance=8
)
```

**审核提案：**

```
memory_core_proposals(action="list")   → 查看待审核列表
memory_core_proposals(action="approve", proposalId="xxx")
memory_core_proposals(action="reject", proposalId="xxx")
```

---

## 7. 记忆作用域（Scope）隔离

### 7.1 隔离维度

```
Scope = {
  userId: "hao.break.zero",       // 用户维度
  agentId: "turning_zero",        // Agent 维度（自动从 sessionKey 推断）
  sessionKey: "agent:turning_zero:main"
}
```

**多 Agent 隔离机制：**

- Core Memory 按 `(userId, agentId)` 过滤，不同 Agent 数据完全隔离
- Free-text 检索传入完整 scope，mem0 按 userId+agentId 隔离向量空间
- 支持 `scope.userIdByAgent` 配置不同 Agent 使用不同 userId

### 7.2 运行时 Scope 推断

```typescript
buildDynamicScope(config.scope, ctx)
  // ctx.agentId 来自运行时（优先级 > 配置值）
  // ctx.sessionKey 来自 OpenClaw 会话（agentId 从 "agent:xxx:main" 解析）
```

---

## 8. 性能分析

### 8.1 关键延迟来源

| 阶段 | 典型延迟 | 影响因素 |
| --- | --- | --- |
| Core Memory 查询 | < 1ms | 本地 JSON 文件（已缓存） |
| Free-text 向量检索 | 2000~5000ms | Ollama bge-m3 推理 |
| 工作区 Fallback 检索 | 10~50ms | 文件读取 + token 匹配 |
| LLM Gate 判断 | 500~3000ms | Gemini API 网络 |
| Outbox 写入 mem0 | 异步，不阻塞 | 后台队列 |

### 8.2 缓存策略

| 缓存层 | 生命周期 | 说明 |
| --- | --- | --- |
| LRU Cache（free-text） | `cacheTtlMs`（60s） | 相同查询结果复用 |
| Session Core Cache | 90s | 同一 session Core 列表复用 |
| Session Relevant Cache | 90s | 相同语义查询 free-text 复用 |
| 注入去重 Window | 30s | 防止同内容重复注入 |

### 8.3 当前 turning_zero 配置下的性能表现

基于 `memory_stats` 实测数据：

- 平均召回延迟：**2714ms**（主要为向量检索）
- Outbox Pending：**0**（无积压）
- Dead Letters：**0**
- Core Memory 条目：**10条**（全部已补充 tier 分类）

---

## 9. 常见问题 FAQ

**Q: 为什么有些内容没有被自动记忆？**

A: 以下情况会被过滤：
1. 内容 < 16 字符（minChars）
2. 命中低信号模式（"好的"、"测试"、"今天"等）
3. 与最近捕获的内容相似度 >= 0.8
4. 含有注入攻击模式或敏感信息

**Q: LLM Gate 不工作？**

A: 检查 `llmGate.apiKey` 是否配置。没有 apiKey 时 LLM Gate 静默跳过，仅 Regex 提取生效。

**Q: Core Memory 会越来越多吗？**

A: 每小时触发 consolidation，自动合并相似度 >= 0.85 的记忆；同 key 的记录只保留最新一条。目前暂无 maxItems 上限，建议定期手动审查。

**Q: 如何查看向量数据库有多少条记忆？**

A: `memory_stats()` 中目前不直接显示向量条数，可通过检查 `outbox.sent` 指标估算历史写入量。

**Q: 多个 Agent 的记忆会互相影响吗？**

A: 不会。`requireAgentId: true` 确保 Core Memory 和向量检索均按 agentId 严格隔离。

---

## 10. 数据文件速查

| 文件路径 | 内容 | 说明 |
| --- | --- | --- |
| `data/memory-memu/core-memory.json` | Core Memory 主存储 | 直接可读 JSON |
| `data/memory-memu/outbox-queue.json` | 待发送队列 | 异常时可手动清空 |
| `data/memory-memu/outbox-deadletter.json` | 死信队列 | 需人工介入 |
| `data/memory-memu/candidate-queue.json` | 捕获候选 | 批处理前的缓冲 |
| `data/memory-memu/core-proposals.json` | 人工审核队列 | 待审核的 core 候选 |
| `data/memory-memu/mem0-vector-store.db` | SQLite 向量数据库 | 含 bge-m3 1024维向量 |
| `workspace-*/MEMORY.md` | Markdown 同步输出 | Agent 启动时直接读取 |

---

> 文档基于 memory-mem0 v1.0.0 源码分析，最后更新 2026-03-16
