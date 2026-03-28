# Memory Quality Fix Plan

**生成时间**: 2026-03-28
**基础版本**: 86c53da
**状态**: 待实施

---

## 第一性原理分析

Memory 系统有三个不可违反的设计约束：

1. **Core Memory = 用户的稳定个人事实**（身份/偏好/目标/关系/约束/工作背景）
2. **Free-text = 有价值的上下文信息**（非临时性、非调试性、非负面发现）
3. **写入应保持正确、持久、唯一**（无幻觉、无重复、无孤儿记录）

当前数据违反了全部三个约束。根本原因可归结为四类：

| 类别 | 根因 | 影响 |
|------|------|------|
| **A. 写入无守卫** | `memory_core_upsert` 工具描述过于宽松，无内容类型校验 | 城规考试笔记等知识内容写入 Core Memory |
| **B. LLM gate 提示词缺陷** | auto-capture 未明确拒绝 bug 报告、负面发现、调试内容 | 问题追踪记录进入 Free-text 向量库 |
| **C. 存储层功能缺失** | `validUntil` TTL 字段在工具层声明但从未持久化；加载时不去重 | 重复 key 存活；TTL 功能无效 |
| **D. 测试无隔离** | E2E 测试写入生产数据路径 | `identity.e2e_marker` 等测试artifact 污染生产数据 |

---

## 任务列表

### T1 — `validUntil` TTL 实现（Phantom feature 修复）

**优先级**: High
**文件**: `core-repository.ts`, `tools/core-upsert.ts`

#### 问题
`memory_core_upsert` 工具声明了 `validUntil` 参数（ISO 8601 过期时间），agent 可以设置它，但 `core-repository.ts` 的 `upsert()` 接受该参数后**直接丢弃**，既不存储，也不检查。`StoredCoreRecord` 类型中不存在 `expiresAt` 字段。

Agent 认为它设置了有效期，实际记录永不过期。这是一个静默失败的 phantom feature。

#### 根因
`upsert()` payload 接受 `validUntil?: string` 但逻辑体中没有写入 `state.items.push({...})` 的 item 对象；`StoredCoreRecord` 类型中也没有该字段。

#### 方案

**步骤 1**: 在 `StoredCoreRecord` 类型中增加 `expiresAt?: number`（epoch ms）。

**步骤 2**: `upsert()` 和 `upsertMany()` 中将 `validUntil` 转换为 `expiresAt`：
```typescript
expiresAt: payload.validUntil ? new Date(payload.validUntil).getTime() : undefined,
```

**步骤 3**: `list()` 调用 `listScopeRecords()` 后过滤过期记录：
```typescript
const now = Date.now();
records = records.filter(r => !r.expiresAt || r.expiresAt > now);
```

**步骤 4**: `loadFromDisk()` 过滤条件中已过期记录直接丢弃（减少文件膨胀）：
```typescript
items: parsed.items.filter((item): item is StoredCoreRecord =>
  // ...existing checks...
  && (!item.expiresAt || item.expiresAt > Date.now())
),
```

#### 验证
```bash
# typecheck 通过
npx tsc --noEmit

# 单元测试（见 T7 新增测试）
npx tsx tests/core-repository.test.ts
```

#### 验收标准
- `validUntil: "2020-01-01T00:00:00Z"` 写入后，`list()` 返回空（已过期）
- `validUntil: "2099-01-01T00:00:00Z"` 写入后，`list()` 返回该记录
- TTL 到期后 `loadFromDisk()` 不加载该记录

---

### T2 — Core Memory 加载时去重

**优先级**: High
**文件**: `core-repository.ts`

#### 问题
当前 `loadFromDisk()` 不检查重复的 `key + scope` 组合。实测数据中存在：
```
key: preferences.workflow_constraint  ×2  (相同 userId/agentId/value)
```

`upsert()` 使用 `.find()` 只找第一个匹配项，第二个永远不被清理。

#### 根因
`upsert()` 可正确防止新增重复，但无法修复**磁盘上已存在的重复记录**。任何写入竞争（旧版 bug、直接文件编辑）产生的重复都会永久留存。

#### 方案
在 `loadFromDisk()` 返回之前，对 items 按 `scope.userId + scope.agentId + scope.tenantId + key` 去重，保留 `updatedAt` 最大的记录：

```typescript
// Deduplicate on load: keep newest by updatedAt per (scope+key)
const seen = new Map<string, StoredCoreRecord>();
for (const item of rawItems) {
  const dedupeKey = `${item.scope.userId}\0${item.scope.agentId}\0${item.scope.tenantId ?? ""}\0${item.key}`;
  const existing = seen.get(dedupeKey);
  if (!existing || item.updatedAt > existing.updatedAt) {
    seen.set(dedupeKey, item);
  }
}
const items = Array.from(seen.values());
```

#### 验证
```bash
# 在测试中构造包含重复 key 的 JSON 文件，加载后验证只有 1 条
npx tsx tests/core-repository.test.ts
```

#### 验收标准
- 磁盘文件含 N 个相同 key+scope 的记录，加载后 `list()` 只返回 1 条（updatedAt 最新的）
- 非重复记录不受影响

---

### T3 — `memory_core_upsert` 工具内容守卫

**优先级**: High
**文件**: `tools/core-upsert.ts`, `security.ts`

#### 问题
`memory_core_upsert` 工具当前描述为 "Create or update a core memory key/value for the current scope"——无任何内容类型约束。Agent 将城乡规划法条、考试笔记、session 临时角色等写入 Core Memory，全部通过。

实测脏数据（22 条知识类 + 若干会话污染）：
- `duoshen_duozheng_reform`, `urban_planning_law_framework` 等城规笔记
- `identity.role: 量化策略研究员`（临时会话角色）
- `identity.e2e_marker`（E2E 测试 artifact）
- `work.goal`, `work.directory`（会话级任务）

#### 根因
工具描述未明确"Core Memory 只存储用户的稳定个人事实"。Value 长度限制（`maxItemChars`）是字符数量守卫，不是语义守卫。

#### 方案

**步骤 1**: 更新工具 description 为明确约束性描述：
```
Store or update a durable personal fact about the user in Core Memory.
Only use this for stable personal attributes: identity, preferences, goals, constraints,
relationships, work background, skills, habits.
Do NOT use for: domain knowledge, study notes, session tasks, debugging context,
temporary role assignments, or time-specific information.
```

**步骤 2**: 在 `security.ts` 新增 `rejectKnowledgeDump()` 检测函数：
```typescript
// 检测知识转储特征（非个人事实）
const KNOWLEDGE_DUMP_PATTERNS = [
  /[①②③④⑤]|（来源：|第\d+条|第\s*[一二三四五六七八九十]+\s*条/,  // 法规条文格式
  /\d+\)\s*\S+.{10,};\s*\d+\)\s*\S+/,                              // 多条并列列表
  /https?:\/\/\S+/,                                                   // URL
];

export function isKnowledgeDump(value: string): boolean {
  return KNOWLEDGE_DUMP_PATTERNS.some(p => p.test(value));
}
```

**步骤 3**: 在 `upsert()` 中调用（与 `shouldStoreCoreMemory` 并列）：
```typescript
if (isKnowledgeDump(value)) {
  this.logger.warn(`core-repo: upsert rejected as knowledge dump: key=${key}`);
  return false;
}
```

**步骤 4**: 增加 `tier` 参数到工具 schema（可选但推荐），强迫 agent 显式声明内容层级：
```typescript
tier: { type: "string", enum: ["profile", "technical", "general"], description: "Memory tier. Use 'profile' for personal facts." }
```

#### 验证
```bash
npx tsc --noEmit
npx tsx tests/core-repository.test.ts
```

#### 验收标准
- `value` 含法规条文格式（如 `①内容；②内容`）→ `upsert()` 返回 `false`
- `value` 含 URL → `upsert()` 返回 `false`
- 正常个人事实（"用户叫昊"）→ 正常存入
- 工具描述更新后 `npx tsc --noEmit` 无报错

---

### T4 — LLM Gate SYSTEM_PROMPT 强化

**优先级**: Medium
**文件**: `core-admission.ts`

#### 问题
当前 `SYSTEM_PROMPT` 的 `free_text` 分类规则为：
> "有价值的上下文信息（技术决策/工作进展/经验教训/项目信息/架构选择）"

导致以下内容被存入 Free-text 向量库：
- `"Capture system has a bug where 'Total Evaluated' remains 0"` → **bug 报告**
- `"no information confirming reboot events for 'opencalw gateway' today"` → **负面发现**
- `"investigating stability of opencalw gateway"` → **会话级调查**（含拼写错误）

#### 根因
Prompt 没有明确排除：bug 报告、调试记录、负面发现（"没有…"）、拼写错误信息、当天事件性信息。

#### 方案
在 `SYSTEM_PROMPT` 的规则部分增加显式拒绝规则：

```
排除规则（必须判为 discard）：
- Bug 报告、错误描述、调试过程记录
- 负面发现或"未找到信息"类表述（如"no information confirming X"）
- 仅在当前会话/当天有效的临时事件
- 包含明显拼写错误或混乱的内容（如 "opencalw" ≠ "openclaw"）
- 纯粹的工具调用结果或系统状态输出
- 代码片段（应使用 code/debug 分类）
```

同时加强 `free_text` 规则描述，要求内容在**多次未来对话中仍有价值**：
```
- free_text: 在未来多次对话中仍有参考价值的信息（用户偏好、项目背景、技术架构决策、
  经过验证的方法论）。不包括本次会话独有的临时信息。
```

#### 验证
构造输入 → 调用 `judgeCandidates()` → 验证 verdict：

| 输入 | 期望 verdict |
|------|-------------|
| "Capture system has a bug where stats remain 0" | `discard` |
| "no information confirming any reboot events today" | `discard` |
| "用户偏好使用 VSCode + Vim 模式" | `core` |
| "项目使用 PostgreSQL 替代 MySQL，原因是 JSONB 支持" | `free_text` |

```bash
npx tsx tests/capture-gate.test.ts
```

#### 验收标准
- 上述 4 个测试用例全部通过
- 现有 `recall-query.test.ts` 24/24 无回退

---

### T5 — Free-text `transient` 质量过滤

**优先级**: Low
**文件**: `backends/free-text/mem0.ts` 或 `backends/free-text/base.ts`

#### 问题
向量库中存在 `quality: "transient"` 的记录（如 "Capture system statistics bug"）。
这些记录在 `search()` 时被正常返回并注入 prompt，但它们本质上是临时调试信息。

#### 方案
在 OSS backend `search()` 结果后处理中，过滤 `transient` 质量的记录（或降低其权重到阈值以下）：

```typescript
// In search result post-processing:
results = results.filter(r => {
  const quality = r.metadata?.quality as string | undefined;
  return quality !== "transient";
});
```

如果业务需要 transient 可见（如短期任务追踪），改为降权：
```typescript
if (quality === "transient") r.score = (r.score ?? 0) * 0.3;
```

#### 验收标准
- `quality: "transient"` 的向量记录不出现在 `memory_recall` 返回结果中
- `quality: "durable"` 的记录不受影响

---

### T6 — 现有脏数据清理

**优先级**: High（应第一个执行，防止脏数据继续注入 prompt）
**文件**: 数据文件（非代码），清理脚本 `scripts/cleanup-dirty-data.ts`

#### 需删除的 Core Memory 条目（按 key）

**知识类内容（22条）**：
```
duoshen_duozheng_reform
control_regulatory_planning_indicators
urban_planning_law_framework
regulatory_planning_approval
supervision_management_2020
planning_qualification_transitional
practical_exam_analysis_method
related_knowledge_architecture
related_knowledge_road
related_knowledge_municipal
related_knowledge_disaster
related_knowledge_economics
tutored_book_city_origin
tutored_book_city_nature
tutored_book_index_system
huaqing_2023_overview
huaqing_2023_exam_structure
huaqing_2023_planning_conditions
huaqing_2023_permit_review
huaqing_2023_analysis_framework
huaqing_2023_answer_skills
city_report_extractor
```

**测试/探针 artifact（2条）**：
```
identity.e2e_marker
identity.main_agent_probe
```

**会话污染（8条）**：
```
identity.role               (量化策略研究员 — 临时会话角色)
identity.persona            (growth_hacker — agent persona，非用户身份)
work.role                   (重复)
work.directory              (quant-research/ — 会话目录)
work.goal                   (飞书文档 API — 会话任务)
work.focus                  (自媒体运营 — 会话级)
goals.research_experiment
goals.research_experiment.duration
goals.research_experiment.success_criteria
```

**重复条目（1条）**：
```
preferences.workflow_constraint  (保留 updatedAt 较新的一条)
```

**过时技术配置（10条）**：
```
general.memory_memu.cb_reset_ms
general.memory_memu.retrieve_timeout
general.memu.retrieve.resource_search
general.memu.retrieve.route_intention
general.memu.retrieve.sufficiency_check
general.memu_server.monthly_cost
general.memu_server.retrieve_p95
general.memory_architecture.layer1
general.memory_architecture.layer2
general.memory_architecture.layer3
general.memory_architecture.layer4
general.memory_architecture.layers_count
```

#### 需删除的 Free-text Vector Store 条目（按 id）

| ID | 原因 |
|----|------|
| `07f22b84-...` | quality=transient，bug 报告 |
| `ccd10faa-...` | growth_hacker 会话 —"investigating opencalw gateway"（拼写错误） |
| `36d3b119-...` | growth_hacker 会话 — "no information confirming reboot events today" |
| `45c85b9b-...` | 幻觉描述 — "OpenClaw is a software-defined robot gripper control framework" |

#### 清理脚本验证方式
```bash
# 1. 运行清理脚本（dry-run 模式先预览）
npx tsx scripts/cleanup-dirty-data.ts --dry-run

# 2. 确认预览正确后执行
npx tsx scripts/cleanup-dirty-data.ts

# 3. 验证清理结果
python3 -c "
import json
with open(os.path.expanduser('~/.openclaw/data/memory-mem0/core-memory.json')) as f:
    d = json.load(f)
print(f'Core memory items: {len(d[\"items\"])}')  # 应约为 40-45 条（从 94 降至清洁集）
"
```

#### 验收标准
- 清理后 core memory 条目数 ≤ 45
- `identity.*` 中不含 `e2e_marker`, `main_agent_probe`, `role: 量化策略研究员`
- 无任何含法规条文格式的 value
- 4 个问题向量条目不存在于 `vector-store.db`

---

### T7 — 测试隔离与新增测试用例

**优先级**: Medium
**文件**: `tests/core-repository.test.ts`（新建），E2E benchmark 配置

#### 问题
E2E 测试写入生产数据路径 `~/.openclaw/data/memory-mem0/`，产生：
- `identity.e2e_marker: "E2E-KIMI-GRAPH-20260321-143353"`

#### 方案

**步骤 1**: E2E 测试使用临时目录：
```typescript
// tests/turning-zero-e2e-benchmark.test.ts
const TEST_DATA_DIR = `/tmp/memory-mem0-test-${Date.now()}`;
// 构造 config 时使用 TEST_DATA_DIR 替代默认路径
```

**步骤 2**: 新建 `tests/core-repository.test.ts`，覆盖 T1/T2/T3 的验收标准：

```typescript
// T1: TTL 验证
test("upsert with expired validUntil: list returns empty", async () => {
  const repo = new CoreMemoryRepository(tmpDir, logger, 500);
  await repo.upsert(scope, { key: "test.ttl", value: "expires", validUntil: "2020-01-01T00:00:00Z" });
  const records = await repo.list(scope);
  assert(records.every(r => r.key !== "test.ttl"), "expired record should not be listed");
});

test("upsert with future validUntil: list returns record", async () => {
  await repo.upsert(scope, { key: "test.ttl2", value: "valid", validUntil: "2099-01-01T00:00:00Z" });
  const records = await repo.list(scope);
  assert(records.some(r => r.key === "test.ttl2"), "non-expired record should be listed");
});

// T2: 加载去重验证
test("loadFromDisk deduplicates same key+scope, keeps newest", async () => {
  // 写入含 2 条同 key 记录的 JSON 文件
  const older = { ...baseRecord, key: "dup.key", value: "old", updatedAt: 1000 };
  const newer = { ...baseRecord, key: "dup.key", value: "new", updatedAt: 2000 };
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, items: [older, newer] }));
  const repo = new CoreMemoryRepository(tmpDir, logger, 500);
  const records = await repo.list(scope);
  assert(records.filter(r => r.key === "dup.key").length === 1, "should have exactly 1 after dedup");
  assert(records.find(r => r.key === "dup.key")?.value === "new", "should keep newest");
});

// T3: 知识转储检测
test("upsert rejects knowledge dump with legal/list format", async () => {
  const ok = await repo.upsert(scope, {
    key: "test.knowledge",
    value: "内容：①合并规划选址；②合并建设用地规划（来源：自然资规〔2019〕2号）",
  });
  assert(!ok, "knowledge dump should be rejected");
});

test("upsert accepts normal personal fact", async () => {
  const ok = await repo.upsert(scope, { key: "identity.name", value: "昊" });
  assert(ok, "personal fact should be accepted");
});
```

#### 验收标准
```bash
npx tsx tests/core-repository.test.ts
# Results: N passed, 0 failed

npx tsc --noEmit
# (no errors)

npx tsx tests/recall-query.test.ts
# Results: 24 passed, 0 failed

npx tsx tests/mem0-backend.test.ts
# Results: 16 passed, 0 failed
```

---

## 实施顺序

```
T6 (数据清理)  →  T2 (去重) + T1 (TTL)  →  T3 (写入守卫)  →  T4 (LLM gate)  →  T5 (transient 过滤)  →  T7 (测试)
```

**理由**:
1. T6 先清脏数据，防止继续注入 prompt（立竿见影）
2. T2+T1 修复存储层基础正确性（无副作用）
3. T3 防止新脏数据写入（守门）
4. T4 防止 auto-capture 污染（守门）
5. T5 处理已有 transient 向量的曝光（低风险）
6. T7 最后补全测试，提供持续保障

---

## 全局验证清单

```bash
# 1. TypeScript 编译无错误
npx tsc --noEmit

# 2. 所有现有测试通过
npx tsx tests/recall-query.test.ts       # 24/24
npx tsx tests/mem0-backend.test.ts       # 16/16

# 3. 新增测试通过
npx tsx tests/core-repository.test.ts    # N/N

# 4. 数据状态验证
python3 << 'EOF'
import json, os, sqlite3
# Core memory
with open(os.path.expanduser('~/.openclaw/data/memory-mem0/core-memory.json')) as f:
    d = json.load(f)
items = d['items']
assert len(items) <= 45, f"Expected ≤45 items, got {len(items)}"
keys = [i['key'] for i in items]
assert 'identity.e2e_marker' not in keys, "e2e_marker still present"
assert 'identity.main_agent_probe' not in keys, "probe still present"
knowledge_keys = [k for k in keys if any(x in k for x in ['huaqing', 'tutored_book', 'related_knowledge', 'duoshen', 'urban_planning', 'regulatory'])]
assert not knowledge_keys, f"Knowledge dump keys still present: {knowledge_keys}"
print(f"✓ Core memory clean: {len(items)} items")

# Vector store
db = sqlite3.connect(os.path.expanduser('~/.openclaw/data/memory-mem0/vector-store.db'))
c = db.cursor()
c.execute('SELECT COUNT(*) FROM vectors')
print(f"✓ Vector store: {c.fetchone()[0]} items")
EOF
```
