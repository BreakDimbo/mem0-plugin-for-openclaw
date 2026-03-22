# 记忆整理机制技术方案

> 版本：v1.0
> 日期：2026-03-22
> 状态：待实现

---

## 一、背景与目标

当前插件通过 `capture` 钩子持续写入 free-text 记忆（mem0）和 core 结构化记忆，随时间累积大量冗余、过时、低信噪比的记忆条目。现有 `consolidate()` 仅做相似度去重，缺少：

- 基于时间周期的主动整理
- 重要性评分与分级淘汰
- LLM 辅助的语义聚类与合并
- Ebbinghaus 衰减模型

**目标**：设计日/周/月三层整理机制，使用本地 Qwen 模型，将记忆分级为「核心记忆 / 重要记忆 / 可丢弃记忆」，持续保持记忆库的精炼与准确。

---

## 二、业界前沿参考

| 系统 / 论文 | 核心思路 | 关键指标 |
|------------|---------|---------|
| **SimpleMem** (arxiv 2601.02553) | 熵感知压缩 → 在线语义合并 → 意图感知检索 | Token↓30×，F1↑26.4% |
| **TeleMem** (arxiv 2601.06037) | 语义聚类 + LLM 决策（增/删/改/不变） | 准确率↑19% vs Mem0，Token↓43% |
| **TiMem** (arxiv 2601.02845) | 时间层级树（日/周/月三层结构化整理） | LoCoMo 75.30%，召回长度↓52% |
| **A-MAC** (arxiv 2603.04549) | 五因子重要性评分线性聚合策略 | F1=0.583，延迟↓31% |
| **SleepGate** (arxiv 2603.14517) | 仿生睡眠整理：冲突检测 + 遗忘门 + 合并 | PI 深度 5 准确率 99.5% |
| **MemOS** (arxiv 2505.22101) | 记忆作为可调度 OS 资源，三层架构 | 准确率↑38.97%，Token↓60.95% |

**本方案主要参考**：TiMem 三层时间树架构 + A-MAC 五因子评分 + Ebbinghaus 遗忘曲线衰减。

---

## 三、分级淘汰原则

### 3.1 三级定义

```
核心记忆 (Core)        写入 core-memory.json，永久驻留，跨会话高优先级召回
重要记忆 (Important)   留在 mem0，打 quality=durable 标记，定期重新评估
可丢弃记忆 (Discard)   从 mem0 删除，写入 dead-letter 日志保留 7 天
```

### 3.2 不同周期的分级阈值

| 周期 | Core 阈值 | Discard 阈值 | 说明 |
|------|----------|-------------|------|
| 日整理 | ≥ 0.75 | < 0.40 | 当日新增，阈值较严 |
| 周整理 | ≥ 0.70 | < 0.35 | 时间证明有价值，适当放宽 |
| 月整理 | ≥ 0.65 | < 0.30 | 充分时间验证，最终裁决 |

### 3.3 强制保护规则（优先于评分）

无论评分高低，以下记忆**不参与 Discard**：

- `tier === "profile"` 的身份特征记忆（日整理保护）
- `importance >= 8` 的显式高优先级记忆（周整理保护）
- 创建时间 < 24 小时的记忆（防误删当日新知识）

---

## 四、重要性评分模型

### 4.1 五因子公式

```
ImportanceScore = w₁·f₁ + w₂·f₂ + w₃·f₃ + w₄·f₄ + w₅·f₅

权重分配:
  w₁ = 0.25  # 时间衰减（recency）
  w₂ = 0.20  # 访问频率（access_frequency）
  w₃ = 0.20  # 语义新颖度（semantic_novelty）
  w₄ = 0.20  # 类型先验（type_prior）
  w₅ = 0.15  # 显式重要性（explicit_importance）
```

### 4.2 各因子计算

#### f₁ — Ebbinghaus 时间衰减

```
f₁ = e^(-t / S)

t = (now - max(touchedAt, updatedAt)) / 86400000  # 单位：天
S = tier 对应半衰期参数（见下表）
```

| Tier | 类别 | 半衰期 S（天） | 设计理由 |
|------|------|-------------|---------|
| profile | identity / preferences / goals / relationships | 90 | 个人稳定特征，极慢衰减 |
| technical | constraints / technical / decision / benchmark | 30 | 技术决策有时效，中速衰减 |
| general | 其他 | 7 | 通用信息，快速衰减 |

#### f₂ — 访问频率

```
f₂ = min(1.0, accessCount / 10)
```

`accessCount` 通过 `touchedAt` 的更新次数近似（需在 `StoredCoreRecord` 新增 `accessCount` 字段），
或简化为：`touchedAt` 存在且与 `updatedAt` 不同则视为被访问过，`f₂ = touchedAt ? 0.5 : 0`。

#### f₃ — 语义新颖度

```
f₃ = 1 - max_similarity

max_similarity = max(trigramSimilarity(value, other.value))
                 for all other in same_category
```

取同类别内最高相似度的补集。若无同类别记忆，`f₃ = 1.0`。

#### f₄ — 类型先验

| category | weight |
|----------|--------|
| identity / profile | 1.0 |
| preferences / goals | 0.9 |
| constraints / relationships | 0.8 |
| technical / decision | 0.7 |
| general（其他） | 0.5 |

#### f₅ — 显式重要性

```
f₅ = (importance ?? 5) / 10     # importance 字段范围 0-10，归一化
```

---

## 五、架构设计

### 5.1 新增文件

```
memory-mem0/
├── consolidation/
│   ├── types.ts              # 类型定义：ConsolidationCycle, ScoredMemory, LLMVerdict
│   ├── scorer.ts             # ImportanceScorer：五因子评分，纯算法无副作用
│   ├── llm-consolidator.ts   # Qwen 调用：聚类决策 + 分级判断
│   ├── scheduler.ts          # ConsolidationScheduler：日/周/月调度
│   └── state.ts              # 整理状态持久化（lastRun 时间戳 + 统计）
└── docs/
    └── memory-consolidation-design.md   # 本文档
```

### 5.2 修改文件

```
types.ts              # 扩展 ConsolidationConfig，新增 QwenConsolidationConfig
openclaw.plugin.json  # 新增配置字段默认值
index.ts              # 注册 ConsolidationScheduler，接入 setInterval tick
core-repository.ts    # 扩展 consolidate() 接受 ImportanceScorer 参数
cli.ts                # 新增 /memu consolidate 子命令
```

### 5.3 数据流

```
[Scheduler.tick() 每小时检查]
         │
         ▼ 满足触发条件
[加载时间窗口内记忆]
  ├─ CoreMemoryRepository.list()    → StoredCoreRecord[]
  └─ FreeTextBackend.list()         → MemuMemoryRecord[]
         │
         ▼
[ImportanceScorer.scoreAll()]
  每条记忆计算五因子 → ImportanceScore ∈ [0, 1]
         │
         ├──▶ 明确 Core   (score ≥ upper threshold)
         ├──▶ 明确 Discard (score < lower threshold，无保护规则)
         └──▶ 边界区间    → 送 Qwen 聚类决策
         │
         ▼
[LLMConsolidator.consolidateBatch()]
  按语义聚类 → batchSize=20 批量送 Qwen
  解析 verdict: core | important | discard | merge
         │
         ├──▶ core    → coreRepo.upsert()
         ├──▶ important → mem0 保留，更新 quality=durable
         ├──▶ merge   → 生成合并摘要 → mem0.store() + 删除原条目
         └──▶ discard → mem0.forget() + 写 dead-letter 日志
         │
         ▼
[ConsolidationState.save()] 更新 lastRun + 统计
```

---

## 六、Qwen 集成方案

### 6.1 接入方式

通过 Ollama 本地服务，使用 OpenAI-compatible API，与现有 `core-admission.ts` 的格式完全一致：

```
POST http://localhost:11434/v1/chat/completions
Authorization: Bearer ollama      # Ollama 默认不验证，任意值
Content-Type: application/json
```

### 6.2 推荐模型选择

| 模型 | VRAM | 速度 | 精度 | 建议场景 |
|------|------|------|------|---------|
| qwen2.5:7b | ~6GB | 快 | 一般 | 日整理（高频，低延迟） |
| qwen2.5:14b | ~10GB | 中 | 好 | 周/月整理（低频，高质量） |
| qwen3:8b | ~6GB | 中 | 优 | 推荐默认（思考模式可关闭） |

### 6.3 分级判断 Prompt

```
你是记忆管理系统的整理员。对以下记忆条目进行${cycle}整理评估。

评级标准：
- core: 用户稳定特征/高频使用/跨会话关键事实（永久保留，写入结构化记忆）
- important: 近期有价值但非核心信息（本${cycle}保留，继续观察）
- discard: 低信号/临时/已过时/与其他条目完全冗余（删除）
- merge: 与指定条目语义重叠，提供合并后的精炼摘要

记忆列表（格式：序号. [类别/键] 值 | 创建:N天前 | 评分:0.XX）：
${memories}

只返回JSON数组，不要其他内容：
[{"index":1,"verdict":"core|important|discard|merge","mergeWith":[2,3],"summary":"合并摘要（仅 merge 时提供）"}]
```

### 6.4 聚类合并 Prompt

```
以下记忆条目语义高度相似，请合并为一条精炼记忆。

要求：
1. 不丢失关键细节（时间、数值、命名实体）
2. 不超过200字
3. 直接陈述事实，不用"用户"作主语
4. 保留最新、最具体的信息

条目：
${cluster.map((m, i) => `${i+1}. ${m.value}`).join('\n')}

只返回合并后的文本，不要JSON或解释。
```

---

## 七、调度机制

### 7.1 调度策略

不使用 cron，采用**每小时 tick + 持久化 lastRun 检测**，兼容进程重启后的补跑：

```typescript
// 每小时 tick 一次，检查是否需要触发
class ConsolidationScheduler {
  async tick(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();

    // 日整理：凌晨3点，距上次 > 20小时
    if (hour === 3 && elapsed(state.lastDaily) > 20 * HOUR) {
      await this.runCycle("daily");
    }

    // 周整理：周一凌晨3点，距上次 > 6天
    if (hour === 3 && now.getDay() === 1 && elapsed(state.lastWeekly) > 6 * DAY) {
      await this.runCycle("weekly");
    }

    // 月整理：每月1日凌晨3点，距上次 > 25天
    if (hour === 3 && now.getDate() === 1 && elapsed(state.lastMonthly) > 25 * DAY) {
      await this.runCycle("monthly");
    }
  }
}
```

在 `index.ts` 的 `on("service_start")` 中：

```typescript
setInterval(() => scheduler.tick().catch(logger.warn), 3600_000); // 每小时
```

### 7.2 各周期处理范围

| 周期 | 记忆时间窗口 | 主要动作 |
|------|------------|---------|
| 日整理 | 今日新增/修改（< 24h） | 评分 → 边界交 Qwen → 升 core / 删 discard |
| 周整理 | 过去 7 天 | 重新评分 + 跨日聚类合并 + 升/降级 |
| 月整理 | 全量记忆 | Ebbinghaus 全量重算 → 最终 GC → 月度统计 |

### 7.3 幂等性保护

整理前写 `consolidation-lock.json`，完成后删除。进程崩溃后下次 tick 检测到 lock 文件则跳过（lock 超过2小时视为过期自动清除）。

---

## 八、配置扩展

### 8.1 openclaw.plugin.json 新增字段

```jsonc
{
  "consolidation": {
    "enabled": true,
    "similarityThreshold": 0.85,

    "daily":   { "enabled": true, "hour": 3 },
    "weekly":  { "enabled": true, "weekday": 1 },
    "monthly": { "enabled": true, "day": 1 },

    "qwen": {
      "enabled": true,
      "apiBase":    "http://localhost:11434/v1",
      "model":      "qwen2.5:14b",
      "timeoutMs":  60000,
      "batchSize":  20
    },

    "scoreThresholds": {
      "daily":   { "core": 0.75, "discard": 0.40 },
      "weekly":  { "core": 0.70, "discard": 0.35 },
      "monthly": { "core": 0.65, "discard": 0.30 }
    },

    "decayParams": {
      "profile":   { "halfLifeDays": 90 },
      "technical": { "halfLifeDays": 30 },
      "general":   { "halfLifeDays": 7  }
    },

    "protection": {
      "minAgeHours":        24,
      "minImportanceWeekly": 8
    },

    "deadLetterRetentionDays": 7
  }
}
```

### 8.2 TypeScript 类型扩展（types.ts）

```typescript
export type QwenConsolidationConfig = {
  enabled: boolean;
  apiBase: string;
  model: string;
  timeoutMs: number;
  batchSize: number;
};

export type CycleScheduleConfig = {
  enabled: boolean;
  hour: number;
  weekday?: number;  // 仅 weekly 使用
  day?: number;      // 仅 monthly 使用
};

export type ConsolidationThresholds = {
  core: number;
  discard: number;
};

export type DecayParams = {
  halfLifeDays: number;
};

// 替换现有 ConsolidationConfig
export type ConsolidationConfig = {
  enabled: boolean;
  intervalMs: number;             // 保留（现有 consolidate() 触发间隔）
  similarityThreshold: number;    // 保留

  daily: CycleScheduleConfig;
  weekly: CycleScheduleConfig;
  monthly: CycleScheduleConfig;

  qwen: QwenConsolidationConfig;

  scoreThresholds: {
    daily: ConsolidationThresholds;
    weekly: ConsolidationThresholds;
    monthly: ConsolidationThresholds;
  };

  decayParams: {
    profile: DecayParams;
    technical: DecayParams;
    general: DecayParams;
  };

  protection: {
    minAgeHours: number;
    minImportanceWeekly: number;
  };

  deadLetterRetentionDays: number;
};
```

---

## 九、CLI 扩展

```
/memu consolidate daily              立即触发日整理
/memu consolidate weekly             立即触发周整理
/memu consolidate monthly            立即触发月整理
/memu consolidate status             显示上次运行时间、处理统计
/memu consolidate daily --dry-run    只输出报告，不实际删除/修改
```

**status 输出示例：**

```
记忆整理状态
─────────────────────────────────────────
日整理   最后执行: 2026-03-22 03:00  处理: 47条  升级: 3  删除: 12
周整理   最后执行: 2026-03-18 03:00  处理: 186条 升级: 8  删除: 31  合并: 14
月整理   最后执行: 2026-03-01 03:00  处理: 621条 升级: 15 删除: 89  合并: 42
─────────────────────────────────────────
当前库存  core: 87条  mem0: 234条
```

---

## 十、实现顺序

```
Phase 1 — 核心评分（无外部依赖，可独立测试）
  consolidation/types.ts
  consolidation/scorer.ts
  types.ts（扩展 ConsolidationConfig）

Phase 2 — LLM 集成
  consolidation/llm-consolidator.ts
  consolidation/state.ts

Phase 3 — 调度器接入
  consolidation/scheduler.ts
  index.ts（注册 tick）
  openclaw.plugin.json（新增配置默认值）

Phase 4 — CLI + 保护机制
  cli.ts（/memu consolidate 子命令）
  dead-letter 日志写入
  --dry-run 模式
```

---

## 十一、测试策略

```
tests/consolidation-scorer.test.ts   # 五因子评分单元测试（边界值/各tier）
tests/consolidation-llm.test.ts      # LLM Consolidator mock 测试（response 解析）
tests/consolidation-e2e.test.ts      # 端到端：插入100条测试记忆 → 运行日整理 → 验证分级结果
```

---

## 十二、执行任务清单

> 每个任务保证可独立测试、可验证、可执行。遵循三条原则：第一性原理、适时反思、最大化有效信息密度。

### 依赖链

```
T1 (类型基础)
 └─▶ T2 (评分算法)
      └─▶ T3 (dry-run 报告)     ← 首个可观测节点，确认算法方向
           └─▶ T4 (core 执行)   ← 首次真实删除，范围最小最安全
                └─▶ T5 (mem0)   ← 扩展到主要噪声来源
                     └─▶ T6 (Qwen) ← LLM 处理模糊边界
                          └─▶ T7 (调度器) ← 自动化
                               └─▶ T8 (CLI) ← 操作界面
                                    └─▶ R1 (反思节点) ← 数据驱动调参
```

---

### T1 — 扩展 Config 类型定义（consolidation foundation）

**目标**：为整理机制建立完整类型基础，所有后续任务依赖此层。

**文件**：
- `consolidation/types.ts`（新建）：`ConsolidationCycle`、`MemoryVerdict`、`ScoredMemory<T>`、`ScoreFactors`、`LLMVerdict`、`ConsolidationReport`
- `types.ts`（修改）：替换 `ConsolidationConfig`，新增 `QwenConsolidationConfig`、`CycleScheduleConfig`、`ConsolidationThresholds`、`DecayParams`
- `openclaw.plugin.json`（修改）：新增 consolidation 配置块默认值

**验收**：`npx tsc --noEmit` 通过，现有代码无新错误

---

### T2 — 实现 ImportanceScorer（五因子评分 + Ebbinghaus 衰减）

**目标**：纯算法模块，输入记忆记录，输出 0-1 重要性分数，无副作用、无外部 IO。

**文件**：`consolidation/scorer.ts`（新建）

**核心接口**：
```typescript
class ImportanceScorer {
  scoreCore(records: CoreMemoryRecord[]): ScoredMemory<CoreMemoryRecord>[]
  scoreFreeText(records: MemuMemoryRecord[]): ScoredMemory<MemuMemoryRecord>[]
}
```

**测试**：`tests/consolidation-scorer.test.ts`（≥5 个测试用例，覆盖各 tier 和边界值）

**验收**：测试全通过；50 条真实记忆的分数分布合理（Core/Important/Discard ≈ 20%/50%/30%）

---

### T3 — 干跑报告（dry-run，仅 core memory）

**目标**：读取 core memory，评分，输出分级报告，**不执行任何写操作**。在真实删除前先看清「会发生什么」。

**文件**：`consolidation/runner.ts`（新建，仅实现 `dryRunCore()`）

**输出示例**：
```
=== 日整理干跑报告 (core memory) ===
总记录: 87 条 | 待升级: 15 | 待标记 important: 48 | 边界区间: 12 | 待删除: 9 | 受保护: 3
```

**测试**：`tests/consolidation-dryrun.test.ts`

**验收**：测试全通过；对真实数据运行，报告可读；不修改任何文件

---

### T4 — 执行 core memory 整理（含 dead-letter 保护）

**目标**：对明确低分的 core 记忆执行删除；边界区间暂跳过（等 T6 LLM 处理）；写 dead-letter 日志作安全网。

**文件**：
- `consolidation/runner.ts`（扩展，新增 `executeCore()`）
- `consolidation/dead-letter.ts`（新建）：写入/读取/清理过期文件

**dead-letter 格式**（按日期分文件 `.jsonl`）：
```jsonl
{"ts":1234567890,"cycle":"daily","id":"...","category":"general","key":"...","value":"...","score":0.18,"reason":"score_below_threshold"}
```

**测试**：`tests/consolidation-execute-core.test.ts`（含幂等性验证）

**验收**：执行后实际删除数与干跑预测一致；dead-letter 文件可读可恢复

---

### T5 — 扩展整理到 free-text memory（mem0）

**目标**：将整理扩展到 mem0——这是记忆冗余的主要来源，是空间维度优化的主战场。

**文件**：`consolidation/runner.ts`（扩展，新增 `dryRunFreeText()`、`executeFreeText()`）、`consolidation/scorer.ts`（扩展 free-text tier 推断）

**Free-text tier 推断**：
- `memory_kind` 为 preference/workflow/constraint → profile (halfLife=90d)
- `memory_kind` 为 technical/decision/architecture → technical (halfLife=30d)
- 其他/未知 → general (halfLife=7d)
- `quality === "durable"` → 额外 +0.1 分

**测试**：`tests/consolidation-freetext.test.ts`（使用 mock backend）

**验收**：测试全通过；执行后 mem0 总量减少，主观召回精度提升

---

### T6 — Qwen LLM 整合器（边界区间裁决 + 合并摘要）

**目标**：对评分在阈值边界 ±0.1 范围内的记忆，用 Qwen 做语义理解后最终裁决，并生成合并摘要替换重复记忆群。

**文件**：`consolidation/llm-consolidator.ts`（新建）

**核心接口**：
```typescript
class LLMConsolidator {
  async judgeMemories(memories, cycle): Promise<LLMVerdict[]>
  async mergeCluster(cluster): Promise<string>
}
```

**Qwen 接入**：`POST ${apiBase}/chat/completions`，与 `core-admission.ts` 格式完全一致

**失败降级**：Qwen 不可用时返回空数组，整理流程继续（LLM 是增强，不是依赖）

**测试**：`tests/consolidation-llm.test.ts`（mock 场景；含 Ollama 联调用例）

**验收**：mock 测试全通过；Qwen 裁决与人工判断一致性 ≥ 80%

---

### T7 — 调度器 + 整理状态持久化

**目标**：日/周/月自动运行，进程重启后能正确补跑遗漏的整理周期。

**文件**：
- `consolidation/state.ts`（新建）：lastRun 持久化 + lock 文件机制
- `consolidation/scheduler.ts`（新建）：每小时 tick + 条件触发
- `index.ts`（修改）：在 `service_start` 注册调度器

**lock 超期保护**：lock 文件超过 2 小时自动视为过期（防崩溃死锁）

**测试**：`tests/consolidation-scheduler.test.ts`（含 lock 竞争、时间条件、重启补跑场景）

**验收**：测试全通过；进程重启后自动补跑；`consolidation-state.json` 可读

---

### T8 — CLI 命令 + 整理状态看板

**目标**：提供人工干预入口；dry-run 让用户在执行前审查决策（「适时反思」的操作界面）。

**文件**：`cli.ts`（扩展现有 `/memu` 命令）

**新增命令**：
```
/memu consolidate [daily|weekly|monthly] [--dry-run]
/memu consolidate status
/memu consolidate unlock
```

**验收**：`--dry-run` 无副作用；`status` 与 state.json 数据一致；Qwen 不可达时 status 正常显示

---

### R1 — 反思节点：跑满一周后调优评分参数

**时机**：T8 完成并自动运行 ≥ 7 天后

**不是编码任务，是结构化反思。**

**需要收集的数据**：
- 每次整理的删除率（目标区间：10-30%）
- 边界区间占比（> 40% 说明阈值需要调整）
- 抽样 20 条 Qwen 裁决的人工评估一致性
- dead-letter 日志中是否有误删的重要记忆

**调优参考**：

| 观察现象 | 调整策略 |
|---------|---------|
| 删除率 < 5% | 降低 discard 阈值 / 缩短 general halfLife |
| 删除率 > 40% | 提高 discard 阈值 / 延长半衰期 |
| 边界区间 > 40% | 扩大 core/discard 阈值间距 |
| Qwen 裁决偏差大 | 优化 Prompt，增加 few-shot 示例 |

**输出**：更新本文档「调优记录」章节 + 必要时修改 `openclaw.plugin.json` 默认值

---

## 附录：关键论文

- SimpleMem: https://arxiv.org/abs/2601.02553
- TeleMem: https://arxiv.org/abs/2601.06037
- TiMem: https://arxiv.org/abs/2601.02845
- A-MAC: https://arxiv.org/abs/2603.04549
- SleepGate: https://arxiv.org/abs/2603.14517
- MemOS: https://arxiv.org/abs/2505.22101
- MemGPT: https://arxiv.org/abs/2310.08560
- Field-Theoretic Memory: https://arxiv.org/abs/2602.21220
- Graph-Native Cognitive Memory: https://arxiv.org/abs/2603.17244
