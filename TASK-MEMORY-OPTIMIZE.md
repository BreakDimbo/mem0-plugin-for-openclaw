# TASK-MEMORY-OPTIMIZE.md

记忆系统优化任务文档
生成日期：2026-03-28
基础原则：记忆系统的根本目的是在未来对话中**准确召回有价值的事实**。
任何不服务于这个目的的内容都是噪声；任何阻止这个目的实现的问题都是 bug。

---

## 任务总览

| ID  | 优先级 | 标题                                 | 核心影响              |
|-----|--------|--------------------------------------|-----------------------|
| T1  | P0     | Free-text 记忆 TTL 过期机制          | 长期运行后召回质量线性下降 |
| T2  | P0     | Free-text 写入路径内容质量守卫        | 知识转储污染向量库     |
| T3  | P1     | 跨会话重复捕获去重（持久化 content hash） | 向量库膨胀，召回噪声增加 |
| T4  | P1     | Core Memory 相关性注入策略修正        | 关键上下文被错误过滤或遗漏 |
| T5  | P2     | Dead-letter 持久化与手动恢复路径      | 数据丢失无感知、无恢复手段 |
| T6  | P2     | Core/Free-text 跨层注入去重           | token 预算浪费，上下文重复 |

执行顺序：T1 → T2 → T3 → T4 → T5 → T6
每个任务完成后必须通过验收测试再进入下一个。

---

## T1：Free-text 记忆 TTL 过期机制

### 第一性原理
信息价值随时间衰减。一条三个月前的 "user is debugging a webpack error" 今天已无用，
但它仍然出现在向量搜索结果里，占用召回名额，挤出真正有价值的最新记忆。
系统没有 TTL，就是一个只增不减的噪声蓄水池。

### 问题根源（代码级）
- `backends/free-text/mem0.ts:buildBaseMetadata()` — 写入时 metadata 不包含过期时间
- `backends/free-text/mem0.ts:filterResults()` — 召回时不过滤过期条目
- `backends/free-text/mem0.ts:list()` — 列出时不过滤过期条目
- mem0 OSS 模式本身不提供 TTL 字段；过期逻辑需要在应用层实现

### 实现方案

#### 写入时（store）
在 `buildBaseMetadata()` 里增加 `expires_at` 字段（epoch 毫秒），
值由配置项 `config.backend.freeText.defaultTtlDays` 控制（默认 90 天）：

```typescript
// backends/free-text/mem0.ts
private buildBaseMetadata(scope, captureKind, extra): Record<string, unknown> {
  const ttlDays = this.config.backend?.freeText?.defaultTtlDays ?? 90;
  const expiresAt = ttlDays > 0 ? Date.now() + ttlDays * 86_400_000 : undefined;
  return {
    scope_user_id: scope.userId,
    scope_agent_id: scope.agentId,
    scope_session_key: scope.sessionKey,
    source: "memory-mem0",
    content_kind: "free-text",
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(captureKind ? { capture_kind: captureKind } : {}),
    ...(extra ?? {}),
  };
}
```

#### 召回时（filterResults）
在 `filterResults()` 里增加过期过滤，默认启用，可通过 `options.includeExpired` 绕过：

```typescript
private filterResults(items, options): MemuMemoryRecord[] {
  const now = Date.now();
  let filtered = items;
  if (!options?.includeExpired) {
    filtered = filtered.filter((item) => {
      const expiresAt = (item.metadata as Record<string, unknown>)?.["expires_at"];
      return typeof expiresAt !== "number" || expiresAt > now;
    });
  }
  // ... existing quality / category / kind filters
  return filtered;
}
```

#### 配置项（types.ts）
```typescript
// 在 FreeTextBackendConfig 类型里增加：
defaultTtlDays?: number;   // 默认 90，0 表示永不过期
```

### 验收测试（tests/free-text-ttl.test.ts）

```
测试 1：写入时 metadata 包含 expires_at
  操作：调用 store()，检查传给 provider.add() 的 metadata
  预期：metadata.expires_at 是一个 > Date.now() 的数字

测试 2：search 不返回已过期条目
  前置：模拟一条 expires_at = Date.now() - 1000 的搜索结果
  操作：调用 search()
  预期：该条目不出现在返回列表中

测试 3：list 不返回已过期条目
  前置：模拟三条记录（已过期 1 条、有效 2 条）
  操作：调用 list()
  预期：返回 2 条，过期那条不在其中

测试 4：defaultTtlDays=0 时永不过期
  前置：config.defaultTtlDays = 0
  操作：调用 store()，检查 metadata
  预期：metadata 中不含 expires_at 字段

测试 5：includeExpired=true 时返回过期条目
  操作：search({ includeExpired: true })
  预期：过期条目也被返回
```

### 验证方式
```bash
npx tsx tests/free-text-ttl.test.ts
```

---

## T2：Free-text 写入路径内容质量守卫

### 第一性原理
向量库的精度 = 有价值记忆数 / 总记忆数。
`isKnowledgeDump()` 保护 Core Memory，但 free-text 写入路径没有等效守卫。
用户粘贴一篇法律条文，只要长度合适就能进向量库，
未来召回时这些内容会占用宝贵的 topK 名额。

### 问题根源（代码级）
- `security.ts:isKnowledgeDump()` — 已实现，但仅在 `shouldStoreCoreMemory()` 中调用
- `outbox.ts:flush()` → `primaryBackend.store()` — 写入前无任何内容守卫
- `index.ts` 中的 candidateQueue processBatch — 直接将 LLM gate 通过的内容入队，无二次检查

### 实现方案

在 `outbox.ts` 的 flush 处理单条 item 时，在调用 `primaryBackend.store()` 前执行检查。
注意：检查应该在 **outbox 层**而非 backend 层，因为 outbox 是统一写入入口。

```typescript
// outbox.ts — 在 flush() 的 chunk.map() 内，primaryBackend.store() 调用之前：
import { isKnowledgeDump, isSensitiveContent } from "./security.js";

// 从 messages 中提取文本进行质量检查
const textForQualityCheck = item.payload.messages
  .filter(m => m.role === "user")
  .map(m => m.content)
  .join("\n")
  .slice(0, 2000);

if (isKnowledgeDump(textForQualityCheck)) {
  this.logger.info(`outbox: quality-reject id=${item.id} (knowledge-dump detected)`);
  // 视作成功处理（不重试）— 内容本身就不该存
  return item.id;
}
```

同时在 `index.ts` 的 candidateQueue `processBatch` 里，对每个 batch item 的 last user message 做检查，在入 outbox 之前过滤：

```typescript
// index.ts processBatch — 在 outbox.enqueue() 之前：
const lastUserText = [...item.item.messages].reverse().find(m => m.role === "user")?.content ?? "";
if (isKnowledgeDump(lastUserText)) {
  api.logger.info(`capture-processor: quality-reject (knowledge-dump), skipping outbox`);
  continue;
}
```

### 验收测试（tests/free-text-quality-guard.test.ts）

```
测试 1：法律条文不进 outbox
  输入：包含 "第十五条 用人单位应当..." 的用户消息
  操作：触发 capture hook 或直接调用 processBatch
  预期：outbox.queue 长度不变；metrics.captureFiltered 递增

测试 2：带圆圈数字的学习笔记不进 outbox
  输入："①合同主体 ②合同内容 ③合同形式"
  预期：同上

测试 3：分号分隔的条款式内容不进 outbox
  输入："甲方负责A；乙方负责B；丙方负责C；丁方负责D"（≥3 分号分隔，每段≥8字符）
  预期：同上

测试 4：正常的用户偏好可以入库
  输入："我平时用 vim，习惯把 tabstop 设为 2"
  预期：outbox.queue 长度增加 1

测试 5：outbox flush 时检测到 knowledge-dump 按成功处理（不入 dead-letter）
  前置：直接构造一个包含知识转储的 OutboxItem 插入队列
  操作：调用 flush()
  预期：item 从队列移除；dead-letter 不增加；sent 计数增加
```

### 验证方式
```bash
npx tsx tests/free-text-quality-guard.test.ts
```

---

## T3：跨会话重复捕获去重（持久化 content hash）

### 第一性原理
`recentCapturesByScope`（`hooks/capture.ts`）是进程内 Map，重启后清空。
用户在多次会话中重复描述同一个偏好，每次都会触发新的 capture，
导致向量库里同一个事实有 N 份轻微措辞不同的拷贝，
所有拷贝都参与召回，结果集里同质信息过多，有效多样性下降。

### 问题根源（代码级）
- `hooks/capture.ts:checkDedup()` — dedup 状态在内存中，进程重启后失效
- `metadata.ts:trigramSimilarity()` — 对"语义相同、措辞不同"的文本去重效果有限
- 无持久化 hash 存储；无跨会话的去重窗口

### 实现方案

#### 新增持久化去重存储（capture-dedup-store.ts）
```typescript
// 新文件：capture-dedup-store.ts
// 持久化一个 {scopeKey → string[]} 的 JSON 文件，
// 存储最近 N 条 capture 的 content hash（sha256 前 16 字节）。
// 每次 capture 成功后追加；超出上限时截断头部。

export class CaptureDedupStore {
  constructor(private persistPath: string, private maxPerScope = 200) {}
  async has(scopeKey: string, hash: string): Promise<boolean> { ... }
  async add(scopeKey: string, hash: string): Promise<void> { ... }
}
```

#### 修改 capture hook
```typescript
// hooks/capture.ts — 在 shouldCapture 和 isLowSignal 检查之后：
import { createHash } from "node:crypto";

const contentHash = createHash("sha256")
  .update(lastUserText.trim().toLowerCase())
  .digest("hex")
  .slice(0, 16);

if (await dedupStore.has(scopeKey, contentHash)) {
  logger.info(`capture-hook: filtered (persistent-dedup, hash=${contentHash})`);
  metrics.captureDeduped++;
  return;
}
// ... enqueue / outbox ...
await dedupStore.add(scopeKey, contentHash);
```

**注意：** 现有的 `trigramSimilarity` 进程内 dedup 保留不变，作为高频短会话的快速过滤层；
持久化 hash 是补充层，处理跨会话的精确重复。

### 验收测试（tests/capture-dedup-persistent.test.ts）

```
测试 1：同一文本在两次独立进程中不会重复 capture
  操作 1：构造 CaptureDedupStore，add("scope", hashOf("我的编辑器是vim"))
  操作 2：新建实例（模拟重启），调用 has("scope", sameHash)
  预期：has() 返回 true（从磁盘恢复）

测试 2：不同文本（不同 hash）不被去重
  操作：add hash A，查询 hash B
  预期：has() 返回 false

测试 3：超出 maxPerScope 后最老的 hash 被淘汰
  前置：maxPerScope=3，add A、B、C
  操作：add D（触发淘汰），查询 A
  预期：has(A) 返回 false，has(D) 返回 true

测试 4：不同 scope 的 hash 互不干扰
  操作：scope1 add hashX，查询 scope2 的 hashX
  预期：has(scope2, hashX) 返回 false

测试 5：持久化文件损坏时优雅降级（不抛出）
  操作：写入非法 JSON，调用 has()
  预期：has() 返回 false，不抛异常
```

### 验证方式
```bash
npx tsx tests/capture-dedup-persistent.test.ts
```

---

## T4：Core Memory 相关性注入策略修正

### 第一性原理
Core Memory 的注入目的是：把对当前查询有用的稳定事实放到 context 里。
当前的 `scoreCoreCandidate()` 用字符级 token overlap 打分，
对语义相关性的判断能力有限（"帮我优化代码" 和 "preferences.editor=vim" 无字符重叠，但高度相关）。
同时存在两个相反的错误：
- **False negative**：有用的 core memory 因 overlap 为 0 被过滤掉
- **False positive**：有字符重叠但语义不相关的 core memory 被注入（浪费 token）

### 当前行为（代码级）
`hooks/recall.ts:selectRelevantCoreMemories()` 流程：
1. 对每条 core memory 调用 `scoreCoreCandidate()`（字符 overlap + conceptBoost）
2. `overlapScore === 0 && conceptBoost < 0.8` → score = 0 → 过滤
3. 按 score 排序后取 topK

关键问题在 line 530：`if (overlapScore === 0 && conceptBoost < 0.8) return 0;`
这意味着没有任何字符重叠且 concept boost 低的 core memory 会被强制评为 0，
即使它是用户最重要的常驻偏好（如编辑器、语言、工作风格）。

### 实现方案

#### 分层注入策略（替换单一 score 排序）

将 core memory 分为两层：
1. **Always-inject 层**（`tier === "pinned"` 或 category 在 identity/preferences/constraints 中）：
   不参与相关性过滤，始终注入（受 token budget 控制）。
   这些是用户的稳定属性，对任何非 greeting/code 查询都有参考价值。
2. **Query-relevant 层**（其余 core memory）：
   用当前的 scoreCoreCandidate 机制选取 topK 最相关的条目。

```typescript
// hooks/recall.ts:selectRelevantCoreMemories()

function selectRelevantCoreMemories(items, searchQueries, intent, classification, topK) {
  const ALWAYS_INJECT_CATEGORIES = new Set(["identity", "preferences", "constraints"]);

  const alwaysInject = items.filter(
    (item) => item.tier === "pinned" || ALWAYS_INJECT_CATEGORIES.has(item.category ?? "")
  );
  const queryRelevant = items.filter(
    (item) => item.tier !== "pinned" && !ALWAYS_INJECT_CATEGORIES.has(item.category ?? "")
  );

  // Score query-relevant items as before
  const scored = queryRelevant.map((item) => ({
    ...item,
    score: scoreCoreCandidate(searchQueries, item, intent),
  }));
  const threshold = 0.05; // 降低阈值：任何非零相关性都保留
  const relevant = scored
    .filter((item) => item.score > threshold)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, topK);

  // 合并：alwaysInject 在前，query-relevant 在后，整体受 filterAlwaysInject 过滤
  return [...filterAlwaysInject(alwaysInject, classification), ...relevant];
}
```

同时：在 `types.ts` 的 `CoreMemoryRecord` 里确认已有 `tier` 字段（若没有则补充），
值为 `"pinned" | "standard"`。

### 验收测试（tests/core-injection-strategy.test.ts）

```
测试 1：identity/preferences 类别的记忆即使 query 无字符重叠也被注入
  前置：core memory = [{category:"preferences", key:"editor", value:"vim"}]
  查询："帮我分析这段 Python 代码"（与 vim 无字符重叠）
  预期：注入结果中包含 preferences/editor

测试 2：非 always-inject 的记忆在 score=0 时被过滤
  前置：core memory = [{category:"project", key:"foo.deadline", value:"2026-06-01"}]
  查询："帮我分析这段 Python 代码"
  预期：注入结果中不含 foo.deadline

测试 3：pinned tier 记忆不受分类过滤影响
  前置：一条 tier="pinned" 的 general 类别记忆
  查询：code 类型查询（通常只注入 identity.name）
  预期：pinned 记忆仍被注入

测试 4：query-relevant 记忆按 score 降序排列
  前置：两条 project 类别记忆，score 分别为 0.8 和 0.3
  预期：score=0.8 的排在前面

测试 5：greeting 类型查询不注入任何 always-inject 记忆
  前置：3 条 preferences 类别记忆
  查询分类：queryType="greeting"
  预期：注入结果为空
```

### 验证方式
```bash
npx tsx tests/core-injection-strategy.test.ts
```

---

## T5：Dead-letter 持久化与手动恢复路径

### 第一性原理
用户说过的话，因为临时网络抖动写入失败，
经过 `maxRetries` 次重试后进入 dead-letter，随后在进程重启时永久丢失。
失败不可见，恢复不可操作，违反了"用户值得信任系统会帮他记住"的根本承诺。

### 问题根源（代码级）
- `outbox.ts:deadLetters` — 内存数组，`saveDeadLetters()` 确实持久化到磁盘（dead-letter.json），
  但 `loadFromDisk()` **不加载** dead-letter（只加载 queue）— 这意味着持久化的 dead-letter 在重启后无法访问
- `cli.ts` — 没有 `/memu dead-letter` 相关命令
- 无手动重试（replay）机制

### 实现方案

#### 修复 loadFromDisk 加载 dead-letter
```typescript
// outbox.ts:loadFromDisk() — 增加 dead-letter 加载：
async loadFromDisk(): Promise<void> {
  // ... existing queue load ...

  // Load dead-letters
  try {
    const dlPath = this.deadLetterPath;
    if (dlPath) {
      const raw = await readFile(expandTilde(dlPath), "utf-8").catch(() => "[]");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.deadLetters = parsed.filter(isValidDeadLetterItem);
      }
    }
  } catch { /* tolerate */ }
}
```

#### 新增 replayDeadLetters() 方法
```typescript
// outbox.ts
async replayDeadLetters(ids?: string[]): Promise<{ replayed: number; skipped: number }> {
  const toReplay = ids
    ? this.deadLetters.filter((dl) => ids.includes(dl.id))
    : [...this.deadLetters];

  let replayed = 0;
  for (const dl of toReplay) {
    // 重置重试计数，重新入队
    this.queue.push({ ...dl, retryCount: 0, nextRetryAt: 0 });
    this.deadLetters = this.deadLetters.filter((d) => d.id !== dl.id);
    replayed++;
  }
  await this.saveToDisk();
  await this.saveDeadLetters();
  return { replayed, skipped: toReplay.length - replayed };
}
```

#### 新增 CLI 命令（cli.ts）
```
/memu dead-letter list        — 列出所有 dead-letter 条目（id、agentId、失败时间、错误）
/memu dead-letter replay      — 将所有 dead-letter 重新入队重试
/memu dead-letter replay <id> — 重试指定 id
/memu dead-letter clear       — 清空 dead-letter（确认后）
```

### 验收测试（tests/outbox-dead-letter.test.ts）

```
测试 1：dead-letter 在进程重启后可恢复
  操作 1：模拟一个写入失败的 item 进入 dead-letter，调用 saveDeadLetters()
  操作 2：新建 OutboxWorker 实例，调用 loadFromDisk()
  预期：deadLetters 数组包含该 item

测试 2：replayDeadLetters() 将条目重新入队
  前置：dead-letter 中有 2 条 item
  操作：调用 replayDeadLetters()
  预期：queue.length 增加 2，deadLetters.length 减少 2，retryCount 归零

测试 3：replayDeadLetters(ids) 只重试指定 id
  前置：dead-letter 中有 A、B 两条
  操作：replayDeadLetters(["A"])
  预期：A 进队列，B 仍在 dead-letter

测试 4：saveDeadLetters() 持久化到正确路径
  操作：push 一条 dead-letter item，调用 saveDeadLetters()
  预期：文件存在，内容可被 JSON.parse，包含该 item 的 id

测试 5：dead-letter 上限（maxDeadLetters）超出时仍可正常加载
  前置：dead-letter.json 中有 600 条（超出 maxDeadLetters=500）
  操作：loadFromDisk()
  预期：内存中只保留最新 500 条，不抛异常
```

### 验证方式
```bash
npx tsx tests/outbox-dead-letter.test.ts
```

---

## T6：Core/Free-text 跨层注入去重

### 第一性原理
两层记忆各自独立注入到 system prompt，导致同一个事实以两种形式出现：
- Core Memory：`[preferences/editor] vim`
- Free-text recall：`用户一直使用 vim 作为主力编辑器`

两者占用两倍 token，而 LLM 接收到的是重复信息，没有额外增益。

### 问题根源（代码级）
- `hooks/recall.ts:createRecallHook()` — 分别构建 coreContext 和 relevantContext，
  无相互感知的去重逻辑
- 当前只做了 free-text 层内部的 seen-set 去重（`id` 或 `text` 为 key）

### 实现方案

在构建最终注入内容前，对 free-text 结果做 core memory 覆盖检测：
若一条 free-text 记忆的核心 key/value 已经被某条 core memory 完全覆盖，则跳过该 free-text 条目。

检测逻辑：
```typescript
// hooks/recall.ts — 在 trimRelevantForInjection 之后，formatMemoriesContext 之前：

function deduplicateAgainstCore(
  relevant: MemuMemoryRecord[],
  coreItems: Array<{ key: string; value: string }>,
): MemuMemoryRecord[] {
  if (coreItems.length === 0) return relevant;

  // 把所有 core values 规范化后放入 Set，用于快速包含查询
  const coreValueTokens = new Set(
    coreItems.flatMap((c) =>
      tokenizeDocument(`${c.key} ${c.value}`)
    )
  );

  return relevant.filter((item) => {
    const itemTokens = tokenizeDocument(item.text);
    if (itemTokens.length === 0) return true;
    // 如果 item 的 token 80% 以上都在 core values 里 → 视为已覆盖，跳过
    const overlapCount = itemTokens.filter((t) => coreValueTokens.has(t)).length;
    const overlapRatio = overlapCount / itemTokens.length;
    return overlapRatio < 0.8;
  });
}
```

此方案保守（阈值 0.8），确保只去掉高度重叠的条目，避免误删互补信息。

### 验收测试（tests/cross-layer-dedup.test.ts）

```
测试 1：free-text 内容与 core memory 高度重叠时被过滤
  前置：core = [{key:"preferences.editor", value:"vim"}]
          free-text = [{text:"用户一直使用vim作为主力编辑器"}]
  操作：调用 deduplicateAgainstCore(freeText, coreItems)
  预期：返回空数组（vim 条目被过滤）

测试 2：free-text 内容与 core memory 无重叠时保留
  前置：core = [{key:"identity.name", value:"Alice"}]
          free-text = [{text:"用户在2025年完成了后端迁移项目"}]
  预期：返回包含该 free-text 条目

测试 3：free-text 内容部分重叠（重叠率 < 0.8）时保留
  前置：core 中有 "vim"，free-text 描述 "vim 和 neovim 的配置差异"
  预期：返回该 free-text 条目（新增信息超过 20%）

测试 4：core memory 为空时 free-text 全部保留
  前置：coreItems = []
  预期：返回原始 relevant 列表

测试 5：去重后 token budget 计算准确
  前置：构造已知的 core + free-text 集合
  操作：运行完整 recall hook 流程（单元测试级模拟）
  预期：最终注入字符数 ≤ config.injectionBudgetChars
```

### 验证方式
```bash
npx tsx tests/cross-layer-dedup.test.ts
```

---

## 整体验收标准

所有任务完成后，以下基准必须同时满足：

1. **T1 验证：** 写入一条 `defaultTtlDays=1` 的记忆，手动将其 `expires_at` 改为过去时间，
   调用 search — 不返回该条目。

2. **T2 验证：** 向 capture hook 发送法律条文（含 "第X条" 格式），
   检查 outbox.queue 和 metrics.captureFiltered — 条文未进队列，filtered 计数增加。

3. **T3 验证：** 同一用户消息发送两次（模拟两次会话，CaptureDedupStore 持久化后重建），
   第二次 capture 被 dedup，outbox 队列不增加。

4. **T4 验证：** `preferences` 类别的 core memory 在代码优化类查询中出现在注入结果里。

5. **T5 验证：** 构造一个超出重试上限的 OutboxItem，重启后调用 `/memu dead-letter list` —
   条目可见；调用 replay — 条目重新出现在 queue 中并被成功处理。

6. **T6 验证：** core memory 包含 "vim"，free-text 包含 "用户使用vim" —
   最终注入 prompt 中只有一处关于 vim 的描述。

---

*文档结束*
