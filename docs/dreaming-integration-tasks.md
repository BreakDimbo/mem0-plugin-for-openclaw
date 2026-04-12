# Dreaming Integration: Executable Task Document

> memory-mem0 plugin v1.0 | 2026-04-12

## Why Dreaming

memory-mem0 的 consolidation 做**减法** -- 按 recency/novelty/tier 评分，淘汰弱记忆。但它缺少**加法**能力：根据实际使用信号（recall 频次、query 多样性、跨天重现）自动将高价值 free-text 记忆提升为 core memory。

openclaw 原生 dreaming（memory-core 扩展）实现了这一能力，但它依赖 cron 服务等特权 API，第三方插件无法使用。本方案将 dreaming 核心逻辑移植到 memory-mem0，复用已有的 `ConsolidationScheduler` 基础设施。

**第一性原理**：记忆的价值不由记忆本身决定，而由它被使用的方式决定。一条被反复召回、跨多天、跨多种 query 上下文命中的 free-text 记忆，应当被提升为 core memory 以获得更强的持久性和注入优先级。

## Architecture Overview

```
Recall Hook (signal collection)
    |
    v
RecallSignalStore (dreaming-signals.json)   PhaseSignalStore (dreaming-phase-signals.json)
    |                                            ^      ^
    v                                            |      |
[ConsolidationScheduler daily tick]              |      |
    |                                            |      |
    +---> Light Phase (dedupe + stage) ----------+      |
    |         |                                         |
    |         v                                         |
    +---> Deep Phase (score + promote)                  |
    |                                                   |
    +---> REM Phase (pattern detect + boost) -----------+
    |
    v
DreamReport (diary + promotions)
```

**数据流**：
1. 每次 recall 注入时，signal store 记录 memory ID、query hash、relevance score
2. Scheduler 在配置的时间触发 dreaming cycle
3. Light 阶段去重、合并相似信号，记录 lightHit
4. Deep 阶段用 6 信号加权评分，将超过阈值的 free-text 提升为 core memory
5. REM 阶段检测概念模式，记录 remHit 供下一周期 Deep 使用

---

## Task Dependency DAG

```
DREAM-01 (types/config)
    |
    +-----> DREAM-02 (signal store)
    |           |
    |           +-----> DREAM-03 (recall hook instrumentation)
    |
    +-----> DREAM-04 (scorer)
    |
    +-----> DREAM-05 (phase signal store)
    |           |
    |           +-----> DREAM-06 (light phase)
    |           |           |
    |           |           +-----> DREAM-07 (deep phase)
    |           |
    |           +-----> DREAM-08 (REM phase)
    |
    +-----> DREAM-09 (runner + scheduler integration)
                  depends on: all above
```

**并行机会**：01 完成后，02/04/05 可并行。06 依赖 02+05，07 依赖 06，08 依赖 05。09 依赖全部。

---

## DREAM-01: Dreaming Types and Configuration

### Why

所有下游任务依赖共享类型定义。没有单一的 `ShortTermRecallEntry`、`PhaseSignalEntry`、`DreamingConfig` 真相源，组件会分歧。此任务也建立配置表面，让运维可以在不改代码的情况下调参。

### Files to Modify

| File | Action |
|------|--------|
| `types.ts` | 在 `MemuPluginConfig` 中添加 `dreaming?: DreamingConfig`，在 `DEFAULT_CONFIG` 中设置默认值 |
| `consolidation/types.ts` | 添加 `ShortTermRecallEntry`, `PhaseSignalEntry`, `DreamScoreFactors`, `DreamReport`, `DreamPromotion` 类型 |

### Type Definitions

```typescript
// ── DreamingConfig (in types.ts) ────────────────────────────────────────────
export type DreamingConfig = {
  enabled: boolean;                          // default: false
  schedule: { hourOfDay: number };           // default: 4 (凌晨4点)
  signalStorePath: string;                   // default: "${dataDir}/dreaming-signals.json"
  phaseSignalStorePath: string;              // default: "${dataDir}/dreaming-phase-signals.json"
  diaryPath: string;                         // default: "${dataDir}/dream-diary.jsonl"
  scoring: {
    weights: DreamScoringWeights;
    promotion: DreamPromotionThresholds;
  };
  maxSignalEntries: number;                  // default: 500, clamped [50, 5000]
  maxQueryHashes: number;                    // default: 32
  maxRecallDays: number;                     // default: 16
  maxPromotionsPerCycle: number;             // default: 5
  dedupeThreshold: number;                   // default: 0.85 (trigram)
  llmDiary: boolean;                         // default: false
  timezone: string;                          // default: "Asia/Shanghai" (用于 recallDays 日期计算)
  normalizeWeights: boolean;                 // default: true (自动归一化权重到和为 1.0)
};

export type DreamScoringWeights = {
  frequency: number;      // 0.24
  relevance: number;      // 0.30
  diversity: number;      // 0.15
  recency: number;        // 0.15
  consolidation: number;  // 0.10
  conceptual: number;     // 0.06
};

export type DreamPromotionThresholds = {
  minScore: number;         // 0.75
  minRecallCount: number;   // 3
  minUniqueQueries: number; // 2
};

// ── Signal Types (in consolidation/types.ts) ────────────────────────────────
export type ShortTermRecallEntry = {
  key: string;                    // memory ID
  layer: "core" | "free-text";
  snippet: string;                // first 80 chars for reporting
  recallCount: number;
  totalScore: number;
  maxScore: number;
  firstRecalledAt: number;        // epoch ms
  lastRecalledAt: number;
  queryHashes: string[];          // SHA-256 truncated to 8 chars, max 32
  recallDays: string[];           // YYYY-MM-DD, max 16
  conceptTags: string[];
  promotedAt?: number;
};

export type PhaseSignalEntry = {
  key: string;
  lightHits: number;
  remHits: number;
  lastLightAt?: number;
  lastRemAt?: number;
};

export type DreamScoreFactors = {
  frequency: number;
  relevance: number;
  diversity: number;
  recency: number;
  consolidation: number;
  conceptual: number;
  phaseBoost: number;
};

export type DreamPhase = "light" | "deep" | "rem";

export type DreamPromotion = {
  sourceKey: string;
  sourceLayer: "free-text";
  targetKey: string;
  score: number;
  factors: DreamScoreFactors;
  reason: string;
};

export type DreamReport = {
  phase: DreamPhase | "all";
  runAt: string;
  candidatesEvaluated: number;
  promotions: DreamPromotion[];
  patternsDetected: number;
  signalBoosts: number;
  diary?: string;
};
```

### Default Configuration

```typescript
// in DEFAULT_CONFIG
dreaming: {
  enabled: false,
  schedule: { hourOfDay: 4 },
  signalStorePath: "",          // resolved at runtime: ${dataDir}/dreaming-signals.json
  phaseSignalStorePath: "",     // resolved at runtime: ${dataDir}/dreaming-phase-signals.json
  diaryPath: "",                // resolved at runtime: ${dataDir}/dream-diary.jsonl
  scoring: {
    weights: { frequency: 0.24, relevance: 0.30, diversity: 0.15, recency: 0.15, consolidation: 0.10, conceptual: 0.06 },
    promotion: { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 2 },
  },
  maxSignalEntries: 500,
  maxQueryHashes: 32,
  maxRecallDays: 16,
  maxPromotionsPerCycle: 5,
  dedupeThreshold: 0.85,
  llmDiary: false,
  timezone: "Asia/Shanghai",
  normalizeWeights: true,
}
```

### Test Plan (`tests/dreaming-types.test.ts`)

| # | Assertion | Category |
|---|-----------|----------|
| 1 | `DEFAULT_CONFIG.dreaming.enabled === false` | Default |
| 2 | `DEFAULT_CONFIG.dreaming.scoring.weights` 六个权重之和 === 1.0 | Invariant |
| 3 | 部分覆写 `{ dreaming: { enabled: true, schedule: { hourOfDay: 5 } } }` 保留其余默认值 | Merge |
| 4 | 部分覆写 `scoring.weights.frequency: 0.5` 后，其余 5 个权重保持默认 | Deep merge |
| 5 | `maxSignalEntries: 10` 被 clamp 到 50；`maxSignalEntries: 10000` 被 clamp 到 5000 | Boundary |
| 6 | `maxPromotionsPerCycle: 0` 被 clamp 到 1 | Boundary |
| 7 | 运行时路径解析：`signalStorePath` 为空时用 `${dataDir}/dreaming-signals.json` | Runtime |
| 8 | 权重之和 != 1.0 时，`normalizeWeights: true` 自动归一化；`false` 时原样使用 | Normalization |
| 9 | `timezone: "Asia/Shanghai"` 用于 `recallDays` 日期字符串生成 | Timezone |

### Estimated LOC

Production: ~120 | Tests: ~80 | Total: ~200

---

## DREAM-02: Short-Term Recall Signal Store

### Why

Dreaming 的价值源于观察**哪些记忆被实际使用**。没有持久化的信号存储，每次重启都会丢失 recall 历史。这个 store 是 dreaming 各阶段消费的"感觉输入"。它必须：crash-safe（write-then-rename）、有界（cap entries）、快速（内存操作 + 周期性 flush）。

### Files to Create

| File | Purpose |
|------|---------|
| `consolidation/signal-store.ts` | RecallSignalStore 类 |

### API Contract

```typescript
export class RecallSignalStore {
  constructor(signalPath: string, config: Pick<DreamingConfig, "maxSignalEntries" | "maxQueryHashes" | "maxRecallDays">);

  /** Loads from disk. Missing file → empty store. */
  async load(): Promise<void>;

  /** Atomic write: write .tmp then rename. Serialized via inflight promise guard. */
  async flush(): Promise<void>;

  /** Record a recall event. Creates entry if absent. */
  recordRecall(params: {
    key: string;
    layer: "core" | "free-text";
    snippet: string;
    queryHash: string;
    relevanceScore: number;
    conceptTags: string[];
  }): void;

  /** All entries as array snapshot. */
  getAll(): ShortTermRecallEntry[];

  /** Single entry lookup. */
  get(key: string): ShortTermRecallEntry | undefined;

  /** Mark entry as promoted. Idempotent. */
  markPromoted(key: string): void;

  /** Prune to maxSignalEntries. Removes promoted-first, then oldest-lastRecalledAt. */
  prune(): void;

  /** Remove a specific entry by key. Returns true if found and removed. */
  delete(key: string): boolean;

  /** Entry count. */
  get size(): number;
}
```

### Persistence Format

```json
{
  "version": 1,
  "updatedAt": "2026-04-12T04:00:00.000Z",
  "entries": [ ...ShortTermRecallEntry[] ]
}
```

Atomic write pattern: 复用 `core-repository.ts` 的 write-tmp-rename 模式（`writeFile(path + ".tmp", data)` → `rename(path + ".tmp", path)`）。

### `recordRecall()` 内部逻辑

```
// Sanitize: clamp relevanceScore to [0, 1], replace NaN/Infinity with 0
sanitizedScore = Number.isFinite(relevanceScore) ? Math.max(0, Math.min(1, relevanceScore)) : 0

if entry exists:
  entry.recallCount++
  entry.totalScore += sanitizedScore
  entry.maxScore = max(entry.maxScore, sanitizedScore)
  entry.lastRecalledAt = Date.now()
  push queryHash if not already in entry.queryHashes (dedup, cap at maxQueryHashes FIFO)
  push today's YYYY-MM-DD (using config.timezone, e.g. Intl.DateTimeFormat) if not in entry.recallDays (dedup, cap at maxRecallDays FIFO)
  merge conceptTags (union, cap at 20)
else:
  create new entry with initial values (using sanitizedScore)
```

### `prune()` 逻辑

```
if entries.size <= maxSignalEntries: return
// Phase 1: remove promoted entries (已完成使命)
sort promoted entries by promotedAt ASC, remove until within cap
// Phase 2: if still over cap, remove by oldest lastRecalledAt
sort remaining by lastRecalledAt ASC, remove until within cap
```

### Test Plan (`tests/dreaming-signal-store.test.ts`)

| # | Assertion | Category |
|---|-----------|----------|
| 1 | `load()` on missing file → `size === 0`，no throw | Init |
| 2 | `recordRecall()` creates new entry with `recallCount: 1`, correct `firstRecalledAt` | Create |
| 3 | `recordRecall()` on existing key → `recallCount` increments to 2 | Update |
| 4 | Duplicate `queryHash` not added twice | Dedup |
| 5 | `queryHashes` 达到 `maxQueryHashes` 后，新 hash 替换最旧（FIFO） | Cap |
| 6 | `recallDays` 达到 `maxRecallDays` 后，新 day 替换最旧 | Cap |
| 7 | `flush()` → `load()` round-trip：数据一致 | Persistence |
| 8 | `markPromoted(key)` sets `promotedAt`，二次调用不覆盖原时间戳 | Idempotent |
| 9 | `prune()`: 600 entries (500 cap), 100 promoted → promoted 先被移除 | Prune-promoted |
| 10 | `prune()`: 600 entries (500 cap), 0 promoted → oldest `lastRecalledAt` 先被移除 | Prune-oldest |
| 11 | `recordRecall()` with empty snippet → entry created with `snippet: ""` | Edge |
| 12 | Concurrent `flush()` calls → second waits for first（inflight promise guard） | Concurrency |
| 13 | `conceptTags` 合并去重，总量不超过 20 | Cap |
| 14 | `recordRecall()` with `relevanceScore: NaN` → sanitized to 0，totalScore 不被污染 | NaN |
| 15 | `recordRecall()` with `relevanceScore: -0.5` → clamped to 0 | Negative |
| 16 | `recordRecall()` with `relevanceScore: Infinity` → sanitized to 0 | Infinity |
| 16b | `recordRecall()` with `relevanceScore: 1.5` → clamped to 1.0 | Clamp |
| 17 | `load()` on corrupt JSON file → log warning, initialize empty store（不 crash） | Corrupt |
| 18 | `load()` on file with `version: 2` → log warning, initialize empty store（forward compat） | Migration |
| 19 | `delete(key)` removes entry, returns true; `delete(unknown)` returns false | Delete |
| 20 | `recallDays` 使用 `Asia/Shanghai` timezone：UTC 23:30 记录为次日 | Timezone |

### Dependencies

DREAM-01

### Estimated LOC

Production: ~200 | Tests: ~180 | Total: ~380

---

## DREAM-03: Recall Hook Signal Instrumentation

### Why

信号必须在记忆**被实际注入 prompt** 的时刻采集。recall hook（`hooks/recall.ts` ~line 930）已经通过 `touchOnRecall` 更新 core memory 的 `touchedAt`。此任务在同一位置添加信号采集，这是唯一同时知道**哪些记忆被召回**和**什么 query 触发**的地方。

### Files to Modify

| File | Change |
|------|--------|
| `hooks/recall.ts` | `createRecallHook()` 增加 `signalStore?: RecallSignalStore` 参数；在注入后为每条记忆调用 `signalStore.recordRecall()` |
| `index.ts` | 实例化 `RecallSignalStore`，传入 `createRecallHook()`；`start()` 中 `load()`，`stop()` 中 `flush()`；添加 60s periodic flush |

### Insertion Points

**recall.ts** — `createRecallHook(deps)`:
- 函数签名添加 `signalStore?: RecallSignalStore`
- **After core memory injection** (~line 930, where `touchOnRecall` fires):
  ```typescript
  if (signalStore) {
    for (const mem of coreMemories) {
      signalStore.recordRecall({
        key: mem.id,
        layer: "core",
        snippet: mem.value.slice(0, 80),
        queryHash: createHash("sha256").update(query).digest("hex").slice(0, 8),
        relevanceScore: mem.score ?? 0,
        conceptTags: [mem.category, mem.tier].filter(Boolean) as string[],
      });
    }
  }
  ```
- **After free-text injection** (~line 916, where `filteredMemories` finalized):
  ```typescript
  if (signalStore) {
    for (const mem of filteredMemories) {
      if (!mem.id) continue; // skip entries without ID
      signalStore.recordRecall({
        key: mem.id,
        layer: "free-text",
        snippet: mem.text.slice(0, 80),
        queryHash: createHash("sha256").update(query).digest("hex").slice(0, 8),
        relevanceScore: mem.score ?? 0,
        conceptTags: [mem.category].filter(Boolean) as string[],
      });
    }
  }
  ```

**index.ts**:
- 在 `register()` 中实例化 `RecallSignalStore`（仅当 `config.dreaming.enabled`）
- 传入 `createRecallHook(..., signalStore)`
- `start()`: `await signalStore?.load()`
- `stop()`: `await signalStore?.flush()`
- `setInterval(() => signalStore?.flush(), 60_000)` — 防止 crash 丢数据

### Backward Compatibility

- `signalStore` 是 optional 参数，不传时行为完全不变
- 当 `dreaming.enabled: false` 时，不实例化 store，不传参
- `recordRecall()` 内部异常被 catch + log，永远不 crash recall hook

### Test Plan (`tests/dreaming-recall-signals.test.ts`)

| # | Assertion | Category |
|---|-----------|----------|
| 1 | Mock store + 模拟 recall（2 core + 1 free-text）→ `recordRecall()` 被调 3 次，`layer` 值正确 | Integration |
| 2 | `dreaming.enabled: false` 或 `signalStore` undefined → `recordRecall()` never called | Guard |
| 3 | 相同 query → 相同 queryHash（确定性） | Determinism |
| 4 | 不同 query → 不同 queryHash | Uniqueness |
| 5 | `relevanceScore` 传入值 === recall 阶段的 `mem.score` | Correctness |
| 6 | free-text memory 无 `id` → 跳过，不报错 | Edge |
| 7 | `recordRecall()` 抛异常 → 被 catch，recall hook 正常返回 | Resilience |

### Dependencies

DREAM-01, DREAM-02

### Estimated LOC

Production: ~50 | Tests: ~100 | Total: ~150

---

## DREAM-04: Dream Scoring Engine

### Why

6 信号加权评分器是 dreaming 的核心。它回答："基于使用行为，这条记忆有多重要？"

现有的 `ImportanceScorer` 用 5 个因子评估记忆**自身属性**（age, tier, similarity）。Dream scorer 用 6 个因子评估**行为信号**（recall 频率、query 多样性、跨天分布）。这是根本不同的评分哲学，两者需要共存。

### Files to Create

| File | Purpose |
|------|---------|
| `consolidation/dream-scorer.ts` | DreamScorer 类 |

### API Contract

```typescript
export class DreamScorer {
  constructor(config: DreamingConfig);

  /** Score a single entry. */
  score(entry: ShortTermRecallEntry, phaseSignal?: PhaseSignalEntry): {
    score: number;
    factors: DreamScoreFactors;
  };

  /** Batch scoring with phase signals. */
  scoreBatch(
    entries: ShortTermRecallEntry[],
    phaseSignals: Map<string, PhaseSignalEntry>,
  ): Array<{ entry: ShortTermRecallEntry; score: number; factors: DreamScoreFactors }>;

  /** Check if entry meets all promotion thresholds. */
  meetsPromotionThreshold(
    entry: ShortTermRecallEntry,
    score: number,
  ): { eligible: boolean; reasons: string[] };
}
```

### Scoring Formula

```
final = w.frequency    * frequency
      + w.relevance    * relevance
      + w.diversity    * diversity
      + w.recency      * recency
      + w.consolidation * consolidation
      + w.conceptual   * conceptual
      + phaseBoost

clamped to [0, 1]
```

**Signal Computations**:

| Signal | Formula | Range |
|--------|---------|-------|
| frequency | `Math.min(1, Math.log1p(recallCount) / Math.log1p(10))` | [0, 1] |
| relevance | `Math.min(1, totalScore / Math.max(1, recallCount))` | [0, 1] |
| diversity | `Math.min(1, Math.max(queryHashes.length, recallDays.length) / 5)` | [0, 1] |
| recency | `Math.exp(-Math.LN2 / 14 * Math.max(0, ageDays))` where `ageDays = (now - lastRecalledAt) / 86400000` | [0, 1] |
| consolidation | `Math.min(1, Math.max(spacing + span, recallDays.length / 5))` | [0, 1] |
| conceptual | `Math.min(1, conceptTags.length / 6)` | [0, 1] |
| phaseBoost | `Math.min(0.13, lightBoost + remBoost)` | [0, 0.13] |

**Note**: 所有 individual factors 都 clamp 到 [0, 1]（frequency 和 relevance 添加了 `Math.min(1, ...)`）。`ageDays` clamp 到 `Math.max(0, ...)` 防止未来时间戳膨胀 recency。

**Consolidation sub-factors** (NOTE: 0.55/0.45 权重仅在外层混合，sub-factors 自身归一到 [0, 1]):
- `spacingRaw`: if `recallDays.length < 2` → 0; else `Math.min(1, Math.log1p(recallDays.length - 1) / Math.log1p(4))`
- `spanRaw`: if `recallDays.length < 2` → 0; else `Math.min(1, spanDays / 30)`
- `spanDays`: `(lastDay - firstDay)` in days from sorted `recallDays`
- `consolidation = Math.min(1, Math.max(spacingRaw * 0.55 + spanRaw * 0.45, recallDays.length / 5))`

**Phase boost**:
- `lightBoost = 0.05 * Math.min(1, lightHits / 3) * Math.exp(-Math.LN2 / 7 * daysSinceLastLight)`
- `remBoost = 0.08 * Math.min(1, remHits / 2) * Math.exp(-Math.LN2 / 7 * daysSinceLastRem)`

**Promotion check**:
```
eligible = score >= minScore
        && recallCount >= minRecallCount
        && queryHashes.length >= minUniqueQueries
        && promotedAt === undefined
```

### Test Plan (`tests/dreaming-scorer.test.ts`)

| # | Assertion | Category |
|---|-----------|----------|
| 1 | frequency: recallCount=0 → 0; recallCount=10 → 1.0; recallCount=5 → ~0.74 | Signal |
| 2 | relevance: totalScore=3.0, recallCount=3 → 1.0; totalScore=0.5, recallCount=5 → 0.1 | Signal |
| 3 | diversity: 1 hash, 1 day → 0.2; 5 hash, 3 day → 1.0; 0 of each → 0 | Signal |
| 4 | recency: lastRecalledAt=now → ~1.0; 14 days ago → ~0.5; 28 days ago → ~0.25 | Signal |
| 5 | consolidation **sub-factor**: 2 recallDays 30 天间隔 → ~0.69 (spacingRaw*0.55 + spanRaw*0.45); 单天 → 0 | Signal |
| 6 | conceptual: 0 tags → 0; 3 tags → 0.5; 6+ tags → 1.0 | Signal |
| 7 | phaseBoost: no signals → 0; lightHits=3 刚命中 → ~0.05; remHits=2 刚命中 → ~0.08 | Signal |
| 8 | 权重之和 === 1.0（精度 1e-10） | Invariant |
| 9 | 全零 entry → score 0，factors 全零 | Edge |
| 10 | score 始终 clamped to [0, 1]（极端高分不超 1） | Bound |
| 11 | `meetsPromotionThreshold`: score=0.80, count=5, queries=3 → eligible | Promotion |
| 12 | `meetsPromotionThreshold`: score=0.80, count=2 → ineligible, reason 包含 "recallCount" | Promotion |
| 13 | `meetsPromotionThreshold`: already promoted → ineligible, reason 包含 "already promoted" | Promotion |
| 14 | `scoreBatch` 返回按 score 降序排列；score 相同时按 key 字典序（稳定排序） | Batch |
| 15 | frequency: recallCount=20 → clamped to 1.0（`Math.min(1, ...)` 生效） | Clamp |
| 16 | recency: `lastRecalledAt` 在未来（clock skew）→ `ageDays` clamped to 0, recency=1.0 | Future-ts |
| 17 | relevance: totalScore=5.0, recallCount=1 → clamped to 1.0 | Clamp |
| 18 | 配置 `normalizeWeights: true` + 权重和 != 1.0 → 自动归一化后 score 正确 | Normalize |

### Dependencies

DREAM-01

### Estimated LOC

Production: ~160 | Tests: ~220 | Total: ~380

---

## DREAM-05: Phase Signal Store

### Why

Phase signals 跨 dream cycles 持久化。Light 阶段的 lightHit 和 REM 阶段的 remHit 在**下一个** Deep 阶段提供评分加成。没有持久化的 phase signals，每个 dream cycle 都从零开始，丢失了多周期学习能力——这正是 dreaming 相对于单次评分的核心优势。

### Files to Create

| File | Purpose |
|------|---------|
| `consolidation/phase-signal-store.ts` | PhaseSignalStore 类 |

### API Contract

```typescript
export class PhaseSignalStore {
  constructor(signalPath: string);

  async load(): Promise<void>;
  async flush(): Promise<void>;

  recordLightHit(key: string): void;
  recordRemHit(key: string): void;

  get(key: string): PhaseSignalEntry | undefined;
  getAll(): Map<string, PhaseSignalEntry>;

  /** Remove entries whose keys are not in activeKeys. */
  prune(activeKeys: Set<string>): number;

  get size(): number;
}
```

### Persistence Format

```json
{
  "version": 1,
  "updatedAt": "2026-04-12T04:00:00.000Z",
  "entries": {
    "mem0-abc123": { "key": "mem0-abc123", "lightHits": 2, "remHits": 1, "lastLightAt": 1712890000000, "lastRemAt": 1712890000000 }
  }
}
```

### Test Plan (`tests/dreaming-phase-signals.test.ts`)

| # | Assertion | Category |
|---|-----------|----------|
| 1 | `load()` on missing file → `size === 0` | Init |
| 2 | `recordLightHit("a")` → `get("a").lightHits === 1`, `lastLightAt` 已设置 | Create |
| 3 | 两次 `recordLightHit("a")` → `lightHits === 2` | Accumulate |
| 4 | `recordRemHit("a")` → `get("a").remHits === 1` | Create |
| 5 | light + rem 独立累计在同一 entry | Independence |
| 6 | `flush()` → `load()` round-trip | Persistence |
| 7 | `prune(new Set(["a"]))` 移除 "b" entry | Prune |
| 8 | `get("unknown")` → undefined | Miss |
| 9 | `prune(new Set())` 移除所有 entries → `size === 0` | Prune-all |
| 10 | `load()` on corrupt JSON → log warning, initialize empty store | Corrupt |

### Dependencies

DREAM-01

### Estimated LOC

Production: ~100 | Tests: ~90 | Total: ~190

---

## DREAM-06: Light Phase -- Deduplicate and Stage

### Why

Light phase 是第一道过滤。它移除信号存储中文本高度相似的重复条目（同一记忆在不同 hash 下被多次记录），防止 Deep 阶段在冗余条目上浪费评分预算。它还分配 lightHit，在未来的 Deep 周期中提供评分加成。

### Files to Create

| File | Purpose |
|------|---------|
| `consolidation/dream-light.ts` | `runLightPhase()` 函数 |

### API Contract

```typescript
export async function runLightPhase(params: {
  signals: RecallSignalStore;
  phaseSignals: PhaseSignalStore;
  config: DreamingConfig;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}): Promise<{
  candidates: ShortTermRecallEntry[];
  deduped: number;
  lightHitsRecorded: number;
}>;
```

### Algorithm

```
1. entries = signals.getAll().filter(e => !e.promotedAt)
2. sort by recallCount DESC (主条目保留最强的)
3. for each entry A (未标记重复):
   for each entry B after A (未标记重复):
     if trigramSimilarity(A.snippet, B.snippet) >= config.dedupeThreshold:
       merge B into A:
         A.recallCount += B.recallCount
         A.totalScore += B.totalScore
         A.maxScore = max(A.maxScore, B.maxScore)
         A.queryHashes = union(A.queryHashes, B.queryHashes).slice(0, maxQueryHashes)
         A.recallDays = union(A.recallDays, B.recallDays).slice(0, maxRecallDays)
         A.conceptTags = union(A.conceptTags, B.conceptTags).slice(0, 20)
       signals.delete(B.key)  // 从 signal store 中移除被合并的 entry
       mark B as duplicate
4. candidates = entries not marked as duplicate
5. for each candidate: phaseSignals.recordLightHit(candidate.key)
6. return { candidates, deduped: duplicateCount, lightHitsRecorded: candidates.length }
```

**复用**：`trigramSimilarity` 从 `metadata.ts` 导入，已在 `consolidation/scorer.ts` 中使用。

### Test Plan (`tests/dreaming-light.test.ts`)

| # | Assertion | Category |
|---|-----------|----------|
| 1 | 两条 snippet 相同的 entry → 合并为 1 条，recallCount 为两者之和 | Merge |
| 2 | 两条 similarity < 0.85 的 entry → 两条都保留 | No-merge |
| 3 | 合并后 queryHashes 取并集（去重） | Merge-detail |
| 4 | 合并后 recallDays 取并集（去重） | Merge-detail |
| 5 | 每个存活候选都获得 lightHit | Signal |
| 6 | 空 signal store → candidates=[], deduped=0 | Empty |
| 7 | 已 promoted 的 entry 被排除 | Filter |
| 8 | 三条互相相似 → 合并为 1 条（传递性通过排序保证：最强的吸收其余） | Transitive |
| 9 | 被合并的 entry 从 signal store 中被 delete（`signals.delete(B.key)` called） | Cleanup |
| 10 | CJK snippets: "用户喜欢深色主题" vs "用户偏好深色主题" similarity < 0.85 → 不合并（documented limitation） | CJK |
| 11 | CJK snippets: 完全相同的中文 → similarity >= 0.85 → 正常合并 | CJK |

### Dependencies

DREAM-01, DREAM-02, DREAM-05 (+ `metadata.ts:trigramSimilarity`)

### Estimated LOC

Production: ~110 | Tests: ~130 | Total: ~240

---

## DREAM-07: Deep Phase -- Score and Promote

### Why

Deep phase 是价值实现层。它用 6 信号评分器对 Light 阶段的候选进行评分，将超过阈值的 free-text 记忆通过 `CoreMemoryRepository.upsert()` 提升为 core memory。这是两个记忆层之间的桥梁。没有它，高价值的 free-text 观察将永远是"二等公民"——不会进入 always-inject tier，也不会在 consolidation 的 recency 偏见中存活。Promotion 赋予它们持久性。

### Files to Create

| File | Purpose |
|------|---------|
| `consolidation/dream-deep.ts` | `runDeepPhase()` 函数 |

### API Contract

```typescript
export async function runDeepPhase(params: {
  candidates: ShortTermRecallEntry[];
  phaseSignals: PhaseSignalStore;
  signals: RecallSignalStore;
  scorer: DreamScorer;
  coreRepo: CoreMemoryRepository;
  freeTextBackend: FreeTextBackend;
  scope: MemoryScope;
  config: DreamingConfig;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  dryRun: boolean;
}): Promise<{
  promotions: DreamPromotion[];
  totalScored: number;
  highScoreCount: number;
}>;
```

### Algorithm

```
1. scored = scorer.scoreBatch(candidates, phaseSignals.getAll())
   -- sorted by score DESC internally

2. // Pre-fetch all free-text memories once, index by ID for O(1) lookup
   allFreeTexts = await freeTextBackend.list(scope, { limit: 5000 })
   freeTextIndex = new Map(allFreeTexts.filter(r => r.id).map(r => [r.id, r]))

   promotions = []
3. for each { entry, score, factors } in scored:
   a. { eligible, reasons } = scorer.meetsPromotionThreshold(entry, score)
   b. if !eligible: log reasons, continue
   c. if entry.layer === "core": log "already in core, score=X", continue
   d. if promotions.length >= config.maxPromotionsPerCycle: break

   // NOTE: list call 在循环外提前执行一次并缓存为 Map，避免 N 次重复请求
   // (见循环前) freeTextIndex = new Map(allFreeTexts.map(r => [r.id, r]))

   e. match = freeTextIndex.get(entry.key)
      if !match: log warning "memory not found in backend", continue

   f. targetKey = `dreaming/${entry.key.slice(0, 12)}`
      if !dryRun:
        await coreRepo.upsert(scope, {
          key: targetKey,
          value: match.text,
          category: "general",
          source: "dreaming",
          importance: score,
          metadata: { dreamScore: score, promotedFrom: "free-text", originalId: entry.key },
          // importance 设为 score (0.75+)，确保新 promoted memory 在 consolidation 评分中不会被立即淘汰
          // consolidation scorer 的 explicitImportance factor 权重 0.15，importance >= 0.75 保证此 factor 接近满分
        })
        signals.markPromoted(entry.key)

   g. promotions.push({ sourceKey: entry.key, sourceLayer: "free-text", targetKey, score, factors, reason: "..." })

4. return { promotions, totalScored: scored.length, highScoreCount: promotions.length + core_skipped }
```

### Test Plan (`tests/dreaming-deep.test.ts`)

| # | Assertion | Category |
|---|-----------|----------|
| 1 | score > 0.75, recallCount=4, uniqueQueries=3 → promoted | Happy path |
| 2 | score > 0.75, recallCount=2 → NOT promoted (threshold) | Threshold |
| 3 | core-layer candidate high score → NOT promoted, report 中出现 "already-core" | Core skip |
| 4 | dryRun=true → `upsert()` 不被调用，promotions 仍然计算 | DryRun |
| 5 | maxPromotionsPerCycle=2, 4 eligible → 只有 top 2 promoted | Cap |
| 6 | `upsert()` 抛异常 → logged，其他 promotion 继续 | Resilience |
| 7 | free-text memory 在 backend 找不到 → skipped with warning | Missing |
| 8 | 已 promoted entry (promotedAt set) → 被 scorer 过滤 | Pre-filter |
| 9 | 0 个 candidate → 返回空 promotions, totalScored=0 | Empty |
| 10 | promoted entry 的 `targetKey` 格式为 `dreaming/xxxx` | Format |
| 11 | dryRun=true 时 `targetKey` 仍然被计算（不为 undefined） | DryRun-detail |
| 12 | promoted memory 的 `importance` >= 0.75，确保 consolidation scorer 不会立即淘汰 | Cross-system |
| 13 | 同一 memory ID 跨两次 dream cycle → 第二次因 `promotedAt` 已设置而跳过（不重复 promote） | Idempotent |

### Dependencies

DREAM-01, DREAM-02, DREAM-04, DREAM-05, DREAM-06

### Estimated LOC

Production: ~160 | Tests: ~200 | Total: ~360

---

## DREAM-08: REM Phase -- Pattern Detection and Signal Boosting

### Why

REM phase 跨**所有**信号条目寻找重复出现的概念模式。如果多条记忆共享 concept tags 且出现在多个 recall days，这个集群代表用户关心的新兴主题。REM 记录 remHit 在未来 Deep 阶段提升这些记忆的评分。这创建了一个正反馈循环：重复主题被发现 → 加强 → 最终被提升——模仿人类 REM 睡眠巩固情感显著记忆的方式。

### Files to Create

| File | Purpose |
|------|---------|
| `consolidation/dream-rem.ts` | `runRemPhase()` 函数 |

### API Contract

```typescript
export async function runRemPhase(params: {
  signals: RecallSignalStore;
  phaseSignals: PhaseSignalStore;
  config: DreamingConfig;
  llm?: LLMConsolidator;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}): Promise<{
  patternsDetected: number;
  signalBoosts: number;
  diary?: string;
}>;
```

### Algorithm

```
1. entries = signals.getAll().filter(e => !e.promotedAt)

2. // Build concept-tag inverted index
   tagToEntries: Map<string, Set<entryKey>> = new Map()
   for each entry:
     for each tag in entry.conceptTags:
       tagToEntries.get(tag).add(entry.key)

3. // Detect patterns: pairs of tags co-occurring in 3+ entries
   patterns: Array<{ tags: [string, string], entries: Set<string> }> = []
   tags = [...tagToEntries.keys()]
   for i in 0..tags.length:
     for j in i+1..tags.length:
       intersection = tagToEntries[tags[i]] ∩ tagToEntries[tags[j]]
       if intersection.size >= 3:
         patterns.push({ tags: [tags[i], tags[j]], entries: intersection })

4. // Record remHit for entries in patterns with cross-day recurrence
   //   每个 entry 每个 cycle 只记录一次 remHit（用 boostedKeys 去重）
   boostedKeys = new Set<string>()
   for each pattern:
     for each entryKey in pattern.entries:
       if boostedKeys.has(entryKey): continue  // 已 boost 过，跳过
       entry = signals.get(entryKey)
       if entry && entry.recallDays.length >= 2:
         phaseSignals.recordRemHit(entryKey)
         boostedKeys.add(entryKey)

5. // Optional diary generation
   diary = undefined
   if llm && config.llmDiary && patterns.length > 0:
     prompt = buildDiaryPrompt(patterns.slice(0, 10), entries)
     diary = await llm.generateDiary(prompt)  // reuse LLM endpoint
     appendToFile(config.diaryPath, JSON.stringify({ runAt: new Date().toISOString(), diary }) + "\n")

6. return { patternsDetected: patterns.length, signalBoosts: boostedKeys.size, diary }
```

### Complexity Guard

Tag pairs: with N unique tags, there are N*(N-1)/2 pairs. Cap unique tags at 50 (取 entry count 最高的 50 个), worst case: 1,225 pairs. Set intersection 用 smaller-set iteration, O(min(|A|, |B|)).

### Test Plan (`tests/dreaming-rem.test.ts`)

| # | Assertion | Category |
|---|-----------|----------|
| 1 | 3 entries 共享 tags ["ts", "test"] → 1 pattern, 3 remHits | Pattern |
| 2 | 2 entries 共享 tags → 0 patterns (低于阈值 3) | Threshold |
| 3 | entry 的 recallDays.length < 2 → 在 pattern 中但不获得 remHit | Cross-day |
| 4 | entry 已被 REM hit 过 → remHits 继续累加 | Accumulate |
| 5 | 无 LLM 配置 → diary undefined, 无 error | No-LLM |
| 6 | LLM 配置 + patterns > 0 → diary 生成并 append 到 diaryPath | Diary |
| 7 | 空 signal store → 0 patterns, 0 boosts | Empty |
| 8 | 500 entries, 50 tags → 完成 < 200ms（documented maxima 下无组合爆炸） | Perf |
| 9 | 超过 50 unique tags → 只取 top 50（按 entry count） | Cap |
| 10 | entry 属于 3 个 pattern → remHit 只记录一次（`boostedKeys` 去重），`phaseSignals.remHits` 为 1 不是 3 | Overlap |

### Dependencies

DREAM-01, DREAM-02, DREAM-05

### Estimated LOC

Production: ~170 | Tests: ~160 | Total: ~330

---

## DREAM-09: Dream Runner and Scheduler Integration

### Why

这是编排层，将所有阶段连接成单一可执行周期，并接入现有的 `ConsolidationScheduler`。没有它，各阶段独立存在无法运行。此任务还处理生命周期：插件启动时初始化 stores，停止时 flush，暴露 CLI 命令 `/memu dream` 用于手动触发和调试。

### Files to Modify

| File | Change |
|------|--------|
| `consolidation/runner.ts` | 添加 `runDreaming(scope, dryRun): Promise<DreamReport>` 方法 |
| `consolidation/scheduler.ts` | 在 tick checks 中添加 `"dreaming"` 周期；`ConsolidationState` 添加 `lastDreamingRun` |
| `consolidation/types.ts` | `ConsolidationState` 添加 `lastDreamingRun?: string`; `ConsolidationCycle` 添加 `| "dreaming"` |
| `index.ts` | 实例化 `RecallSignalStore` + `PhaseSignalStore`，传入 runner 和 recall hook |

### Runner Orchestration

```typescript
// ConsolidationRunner.runDreaming()
async runDreaming(scope: MemoryScope, dryRun: boolean): Promise<DreamReport> {
  const now = new Date().toISOString();

  // 0. Inflight guard: prevent overlapping dream cycles
  if (this._dreamingInflight) {
    this.logger.warn("dreaming cycle already in progress, skipping");
    return emptyDreamReport(now);
  }
  this._dreamingInflight = true;
  try {

  // 1. Acquire exclusive access: pause periodic signal flush during dream cycle
  //    to prevent recall hook's flush from racing with our load/flush.
  //    The recall hook's recordRecall() writes to the SAME in-memory Map,
  //    which is safe (single-threaded Node.js), but flush() must be serialized.
  this.pausePeriodicFlush?.();
  await this.signalStore.load();
  await this.phaseSignalStore.load();

  // 2. Light phase
  const light = await runLightPhase({
    signals: this.signalStore,
    phaseSignals: this.phaseSignalStore,
    config: this.dreamingConfig,
    logger: this.logger,
  });

  // 3. Deep phase
  const deep = await runDeepPhase({
    candidates: light.candidates,
    phaseSignals: this.phaseSignalStore,
    signals: this.signalStore,
    scorer: this.dreamScorer,
    coreRepo: this.repo,
    freeTextBackend: this.freeTextBackend,
    scope,
    config: this.dreamingConfig,
    logger: this.logger,
    dryRun,
  });

  // 4. REM phase
  const rem = await runRemPhase({
    signals: this.signalStore,
    phaseSignals: this.phaseSignalStore,
    config: this.dreamingConfig,
    llm: this.llmConsolidator,
    logger: this.logger,
  });

  // 5. Prune and persist
  this.signalStore.prune();
  const activeKeys = new Set(this.signalStore.getAll().map(e => e.key));
  this.phaseSignalStore.prune(activeKeys);
  await this.signalStore.flush();
  await this.phaseSignalStore.flush();

  } finally {
    this._dreamingInflight = false;
    this.resumePeriodicFlush?.();
  }

  return {
    phase: "all",
    runAt: now,
    candidatesEvaluated: deep.totalScored,
    promotions: deep.promotions,
    patternsDetected: rem.patternsDetected,
    signalBoosts: rem.signalBoosts,
    diary: rem.diary,
  };
}
```

### Scheduler Integration

In `scheduler.ts` `tick()`, add to the checks array:

```typescript
const dreamingCfg = this.config.dreaming ?? { enabled: false, schedule: { hourOfDay: 4 } };
const checks: Array<[ConsolidationCycle, boolean, boolean]> = [
  // ... existing daily/weekly/monthly
  ["dreaming", dreamingCfg.enabled, hour === dreamingCfg.schedule.hourOfDay && !isSameDayHour(state.lastDreamingRun, dreamingCfg.schedule.hourOfDay)],
];
```

In `runCycle()`, add routing:

```typescript
if (cycle === "dreaming") {
  // Write lastDreamingRun BEFORE running to prevent overlapping triggers
  // (if cycle takes longer than tick interval, second tick sees timestamp and skips)
  state.lastDreamingRun = new Date().toISOString();
  await saveState(this.config.statePath, state);
  const report = await this.runner.runDreaming(this.scope, dryRun);
  state.lastDreamReport = report;
  await saveState(this.config.statePath, state);
  return;
}
```

### index.ts Wiring

```typescript
// In register(), after creating coreRepo and freeTextBackend:
const signalStore = config.dreaming.enabled
  ? new RecallSignalStore(resolvedSignalStorePath, config.dreaming)
  : undefined;
const phaseSignalStore = config.dreaming.enabled
  ? new PhaseSignalStore(resolvedPhaseSignalStorePath)
  : undefined;

// Pass to runner
const runner = new ConsolidationRunner(coreRepo, config.core.consolidation, logger, freeTextBackend, {
  signalStore, phaseSignalStore, dreamingConfig: config.dreaming,
});

// Pass to recall hook
const recallHook = createRecallHook({
  ..., signalStore,
});

// In start():
await signalStore?.load();
await phaseSignalStore?.load();
let signalFlushPaused = false;
const signalFlushTimer = signalStore
  ? setInterval(() => {
      if (!signalFlushPaused) signalStore.flush().catch(logger.warn);
    }, 60_000)
  : undefined;

// Pause/resume for dream cycle exclusion
const pausePeriodicFlush = () => { signalFlushPaused = true; };
const resumePeriodicFlush = () => { signalFlushPaused = false; };

// Pass to runner constructor
runner.setPauseResumeFlush(pausePeriodicFlush, resumePeriodicFlush);

// In stop():
if (signalFlushTimer) clearInterval(signalFlushTimer);
await signalStore?.flush();
await phaseSignalStore?.flush();
```

### Test Plan (`tests/dreaming-runner.test.ts`)

| # | Assertion | Category |
|---|-----------|----------|
| 1 | 空 signal store → report: 0 candidates, 0 promotions, 0 patterns | Empty |
| 2 | 5 signal entries (2 eligible) → 2 promotions, 正确 scores | Integration |
| 3 | dryRun=true → promotions 计算但 `upsert()` 不调用 | DryRun |
| 4 | stores 在 run 后被 flush（验证文件存在） | Persistence |
| 5 | phase signals 跨两次 `runDreaming()` 调用累积（第一次 lightHit 提升第二次 score） | Cross-cycle |
| 6 | `prune()` 在 run 结束后执行 | Lifecycle |

### Test Plan (`tests/dreaming-scheduler.test.ts`)

| # | Assertion | Category |
|---|-----------|----------|
| 7 | scheduler tick at dreaming hour → `runDreaming()` 被调用 | Trigger |
| 8 | scheduler tick at non-dreaming hour → 不触发 | Guard |
| 9 | `lastDreamingRun` 被持久化到 state file | State |
| 10 | 同一小时内的重复 tick → 不重复触发 | Idempotent |
| 11 | `forceRun("dreaming", false)` → 正常执行 | Manual |
| 12 | `dreaming.enabled: false` → tick 永不触发 | Disabled |
| 13 | 并发 `runDreaming()` → 第二次立即返回 empty report（inflight guard） | Concurrency |
| 14 | `lastDreamingRun` 在 dream cycle 开始前写入（防止慢 cycle 被重复触发） | Overlap |
| 15 | dream cycle 期间 periodic flush 暂停；结束后恢复 | Flush-pause |
| 16 | dream cycle 期间 recall hook 的 `recordRecall()` 仍正常工作（内存写入安全） | Concurrent-write |

### Dependencies

All DREAM-01 through DREAM-08

### Estimated LOC

Production: ~200 (runner) + ~60 (scheduler) + ~40 (types) + ~50 (index.ts) | Tests: ~280 | Total: ~630

---

## Summary

| Task | Production LOC | Test LOC | Total | Files |
|------|---------------|----------|-------|-------|
| DREAM-01 Types & Config | 130 | 100 | 230 | types.ts, consolidation/types.ts |
| DREAM-02 Signal Store | 220 | 230 | 450 | consolidation/signal-store.ts |
| DREAM-03 Recall Instrumentation | 50 | 100 | 150 | hooks/recall.ts, index.ts |
| DREAM-04 Scorer | 170 | 260 | 430 | consolidation/dream-scorer.ts |
| DREAM-05 Phase Signal Store | 110 | 110 | 220 | consolidation/phase-signal-store.ts |
| DREAM-06 Light Phase | 120 | 160 | 280 | consolidation/dream-light.ts |
| DREAM-07 Deep Phase | 170 | 240 | 410 | consolidation/dream-deep.ts |
| DREAM-08 REM Phase | 170 | 170 | 340 | consolidation/dream-rem.ts |
| DREAM-09 Runner & Scheduler | 380 | 340 | 720 | runner.ts, scheduler.ts, index.ts |
| **Total** | **1,520** | **1,710** | **3,230** | |

## Execution Order

```
Phase 1: DREAM-01 (foundation)
Phase 2: DREAM-02 + DREAM-04 + DREAM-05 (parallel, independent)
Phase 3: DREAM-03 + DREAM-06 (parallel after deps)
Phase 4: DREAM-07 + DREAM-08 (parallel after deps)
Phase 5: DREAM-09 (integration, depends on all)
```

## Verification Strategy

每个任务完成后：
1. `npx tsx tests/dreaming-<name>.test.ts` — 所有断言通过
2. `npm run typecheck` — 无类型错误
3. 增量式：每个任务的测试只依赖已完成的任务

全量集成验证（DREAM-09 完成后）：
1. 配置 `dreaming.enabled: true`，启动插件
2. 触发若干次 recall（通过 memory_recall tool）
3. `forceRun("dreaming", true)` — dry-run 查看 report
4. `forceRun("dreaming", false)` — 验证 promotion 写入 core memory
5. 检查 `dreaming-signals.json` 和 `dreaming-phase-signals.json` 正确持久化
6. 第二次 `forceRun` 验证 phase signals 的跨周期累积效果
