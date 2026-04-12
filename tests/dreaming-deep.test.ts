// ============================================================================
// Tests: Deep Phase -- Score and Promote (DREAM-07)
// Run with: npx tsx tests/dreaming-deep.test.ts
// ============================================================================

import { runDeepPhase } from "../consolidation/dream-deep.js";
import type { DreamScoreFactors, ShortTermRecallEntry } from "../consolidation/types.js";
import type { MemoryScope, MemuMemoryRecord } from "../types.js";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, passed: false, error: String(err) });
    console.log(`  ✗ ${name}: ${String(err)}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const defaultScope: MemoryScope = { userId: "u1", agentId: "a1", sessionKey: "s1" };

class MockScorer {
  private scores = new Map<string, number>();

  setScore(key: string, score: number) {
    this.scores.set(key, score);
  }

  scoreBatch(entries: ShortTermRecallEntry[]) {
    return entries.map((entry) => {
      const score = this.scores.get(entry.key) ?? 0;
      return {
        entry,
        score,
        factors: {
          frequency: 0.8,
          relevance: 0.8,
          diversity: 0.8,
          recency: 0.8,
          consolidation: 0.8,
          conceptual: 0.8,
          phaseBoost: 0,
        } as DreamScoreFactors,
      };
    }).sort((a, b) => b.score - a.score || a.entry.key.localeCompare(b.entry.key));
  }

  meetsPromotionThreshold(entry: ShortTermRecallEntry, score: number) {
    if (entry.promotedAt !== undefined) {
      return { eligible: false, reasons: ["already promoted"] };
    }
    const reasons: string[] = [];
    if (score < 0.75) reasons.push(`score ${score.toFixed(2)} < minScore 0.75`);
    if (entry.recallCount < 3) reasons.push(`recallCount ${entry.recallCount} < minRecallCount 3`);
    if (entry.queryHashes.length < 2) reasons.push(`queryHashes ${entry.queryHashes.length} < minUniqueQueries 2`);
    const eligible = reasons.length === 0;
    return { eligible, reasons };
  }
}

class MockSignalStore {
  private entries = new Map<string, ShortTermRecallEntry>();
  promotedKeys: string[] = [];

  getAll() {
    return Array.from(this.entries.values());
  }

  get(key: string) {
    return this.entries.get(key);
  }

  markPromoted(key: string) {
    this.promotedKeys.push(key);
    const entry = this.entries.get(key);
    if (entry && entry.promotedAt === undefined) {
      entry.promotedAt = Date.now();
    }
  }

  add(entry: ShortTermRecallEntry) {
    this.entries.set(entry.key, entry);
  }
}

class MockPhaseSignalStore {
  getAll() {
    return new Map();
  }
}

class MockCoreRepo {
  upserts: Array<{ scope: MemoryScope; payload: any }> = [];
  throwOnKey: string | null = null;

  async upsert(scope: MemoryScope, payload: any) {
    if (this.throwOnKey === payload.key) {
      throw new Error("upsert failed");
    }
    this.upserts.push({ scope, payload });
    return true;
  }
}

class MockFreeTextBackend {
  memories: MemuMemoryRecord[] = [];

  async list() {
    return this.memories;
  }
}

function createLogger() {
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    logs,
    warns,
    info: (...args: unknown[]) => logs.push(args.join(" ")),
    warn: (...args: unknown[]) => warns.push(args.join(" ")),
  };
}

function makeConfig(maxPromotionsPerCycle = 5): any {
  return {
    enabled: true,
    schedule: { hourOfDay: 4 },
    signalStorePath: "",
    phaseSignalStorePath: "",
    diaryPath: "",
    scoring: {
      weights: { frequency: 0.24, relevance: 0.30, diversity: 0.15, recency: 0.15, consolidation: 0.10, conceptual: 0.06 },
      promotion: { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 2 },
    },
    maxSignalEntries: 500,
    maxQueryHashes: 32,
    maxRecallDays: 16,
    maxPromotionsPerCycle,
    maxConceptTags: 20,
    dedupeThreshold: 0.85,
    llmDiary: false,
    timezone: "Asia/Shanghai",
    normalizeWeights: false,
  };
}

function baseEntry(overrides?: Partial<ShortTermRecallEntry>): ShortTermRecallEntry {
  return {
    key: "test-key",
    layer: "free-text",
    snippet: "test snippet",
    recallCount: 4,
    totalScore: 3.2,
    maxScore: 0.9,
    firstRecalledAt: Date.now(),
    lastRecalledAt: Date.now(),
    queryHashes: ["q1", "q2", "q3"],
    recallDays: ["2026-04-10", "2026-04-11"],
    conceptTags: ["general"],
    ...overrides,
  };
}

console.log("\nDeep Phase Tests (DREAM-07)\n");

// 1. Happy path: score > 0.75, recallCount=4, uniqueQueries=3 → promoted
await test("happy path: eligible free-text candidate is promoted", async () => {
  const scorer = new MockScorer();
  scorer.setScore("ft-1", 0.8);

  const signals = new MockSignalStore();
  signals.add(baseEntry({ key: "ft-1" }));

  const backend = new MockFreeTextBackend();
  backend.memories = [{ id: "ft-1", text: "memory text", category: "general", source: "memu_item", scope: defaultScope }];

  const coreRepo = new MockCoreRepo();
  const logger = createLogger();

  const result = await runDeepPhase({
    candidates: signals.getAll(),
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: signals as any,
    scorer: scorer as any,
    coreRepo: coreRepo as any,
    freeTextBackend: backend as any,
    scope: defaultScope,
    config: makeConfig(),
    logger,
    dryRun: false,
  });

  assertEqual(result.promotions.length, 1, "promotions count");
  assertEqual(result.promotions[0].sourceKey, "ft-1", "sourceKey");
  assertEqual(result.promotions[0].sourceLayer, "free-text", "sourceLayer");
  assertTrue(signals.promotedKeys.includes("ft-1"), "markPromoted called");
  assertEqual(coreRepo.upserts.length, 1, "upsert called once");
});

// 2. Threshold: score > 0.75, recallCount=2 → NOT promoted
await test("threshold: low recallCount prevents promotion", async () => {
  const scorer = new MockScorer();
  scorer.setScore("ft-2", 0.8);

  const signals = new MockSignalStore();
  signals.add(baseEntry({ key: "ft-2", recallCount: 2 }));

  const logger = createLogger();

  const result = await runDeepPhase({
    candidates: signals.getAll(),
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: signals as any,
    scorer: scorer as any,
    coreRepo: new MockCoreRepo() as any,
    freeTextBackend: new MockFreeTextBackend() as any,
    scope: defaultScope,
    config: makeConfig(),
    logger,
    dryRun: false,
  });

  assertEqual(result.promotions.length, 0, "no promotions");
  assertEqual(result.totalScored, 1, "totalScored");
  assertEqual(result.highScoreCount, 0, "highScoreCount");
  assertTrue(logger.logs.some((l) => l.includes("not eligible")), "ineligible logged");
});

// 3. Core-layer candidate high score → NOT promoted, report contains "already-core"
await test("core-layer candidate is skipped with already-core log", async () => {
  const scorer = new MockScorer();
  scorer.setScore("core-1", 0.8);

  const signals = new MockSignalStore();
  signals.add(baseEntry({ key: "core-1", layer: "core", recallCount: 5 }));

  const logger = createLogger();

  const result = await runDeepPhase({
    candidates: signals.getAll(),
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: signals as any,
    scorer: scorer as any,
    coreRepo: new MockCoreRepo() as any,
    freeTextBackend: new MockFreeTextBackend() as any,
    scope: defaultScope,
    config: makeConfig(),
    logger,
    dryRun: false,
  });

  assertEqual(result.promotions.length, 0, "no promotions");
  assertEqual(result.highScoreCount, 1, "highScoreCount includes core skip");
  assertTrue(logger.logs.some((l) => l.includes("already in core")), "log contains already in core");
});

// 4. dryRun=true → upsert() not called, promotions still calculated
await test("dryRun prevents upsert but promotions still calculated", async () => {
  const scorer = new MockScorer();
  scorer.setScore("ft-3", 0.8);

  const signals = new MockSignalStore();
  signals.add(baseEntry({ key: "ft-3" }));

  const backend = new MockFreeTextBackend();
  backend.memories = [{ id: "ft-3", text: "memory text", category: "general", source: "memu_item", scope: defaultScope }];

  const coreRepo = new MockCoreRepo();
  const logger = createLogger();

  const result = await runDeepPhase({
    candidates: signals.getAll(),
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: signals as any,
    scorer: scorer as any,
    coreRepo: coreRepo as any,
    freeTextBackend: backend as any,
    scope: defaultScope,
    config: makeConfig(),
    logger,
    dryRun: true,
  });

  assertEqual(result.promotions.length, 1, "promotion calculated");
  assertEqual(coreRepo.upserts.length, 0, "upsert not called");
  assertEqual(signals.promotedKeys.length, 0, "markPromoted not called");
});

// 5. maxPromotionsPerCycle=2, 4 eligible → only top 2 promoted
await test("maxPromotionsPerCycle caps promotions to top 2", async () => {
  const scorer = new MockScorer();
  scorer.setScore("ft-a", 0.95);
  scorer.setScore("ft-b", 0.90);
  scorer.setScore("ft-c", 0.85);
  scorer.setScore("ft-d", 0.80);

  const signals = new MockSignalStore();
  signals.add(baseEntry({ key: "ft-a" }));
  signals.add(baseEntry({ key: "ft-b" }));
  signals.add(baseEntry({ key: "ft-c" }));
  signals.add(baseEntry({ key: "ft-d" }));

  const backend = new MockFreeTextBackend();
  backend.memories = [
    { id: "ft-a", text: "a", category: "general", source: "memu_item", scope: defaultScope },
    { id: "ft-b", text: "b", category: "general", source: "memu_item", scope: defaultScope },
    { id: "ft-c", text: "c", category: "general", source: "memu_item", scope: defaultScope },
    { id: "ft-d", text: "d", category: "general", source: "memu_item", scope: defaultScope },
  ];

  const result = await runDeepPhase({
    candidates: signals.getAll(),
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: signals as any,
    scorer: scorer as any,
    coreRepo: new MockCoreRepo() as any,
    freeTextBackend: backend as any,
    scope: defaultScope,
    config: makeConfig(2),
    logger: createLogger(),
    dryRun: false,
  });

  assertEqual(result.promotions.length, 2, "only 2 promoted");
  assertEqual(result.promotions[0].sourceKey, "ft-a", "highest score first");
  assertEqual(result.promotions[1].sourceKey, "ft-b", "second highest score");
});

// 6. upsert() throws → logged, other promotions continue
await test("upsert exception is logged and other promotions continue", async () => {
  const scorer = new MockScorer();
  scorer.setScore("ft-throw", 0.9);
  scorer.setScore("ft-ok", 0.8);

  const signals = new MockSignalStore();
  signals.add(baseEntry({ key: "ft-throw" }));
  signals.add(baseEntry({ key: "ft-ok" }));

  const backend = new MockFreeTextBackend();
  backend.memories = [
    { id: "ft-throw", text: "throw", category: "general", source: "memu_item", scope: defaultScope },
    { id: "ft-ok", text: "ok", category: "general", source: "memu_item", scope: defaultScope },
  ];

  const coreRepo = new MockCoreRepo();
  coreRepo.throwOnKey = "dreaming.ft-throw";

  const logger = createLogger();

  const result = await runDeepPhase({
    candidates: signals.getAll(),
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: signals as any,
    scorer: scorer as any,
    coreRepo: coreRepo as any,
    freeTextBackend: backend as any,
    scope: defaultScope,
    config: makeConfig(),
    logger,
    dryRun: false,
  });

  assertEqual(result.promotions.length, 1, "only ft-ok promoted");
  assertEqual(result.promotions[0].sourceKey, "ft-ok", "ft-ok promoted");
  assertTrue(logger.warns.some((w) => w.includes("promotion failed")), "failure logged");
  assertTrue(!signals.promotedKeys.includes("ft-throw"), "ft-throw not marked promoted");
  assertTrue(signals.promotedKeys.includes("ft-ok"), "ft-ok marked promoted");
});

// 7. free-text memory not found in backend → skipped with warning
await test("missing backend memory is skipped with warning", async () => {
  const scorer = new MockScorer();
  scorer.setScore("ft-missing", 0.8);

  const signals = new MockSignalStore();
  signals.add(baseEntry({ key: "ft-missing" }));

  const logger = createLogger();

  const result = await runDeepPhase({
    candidates: signals.getAll(),
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: signals as any,
    scorer: scorer as any,
    coreRepo: new MockCoreRepo() as any,
    freeTextBackend: new MockFreeTextBackend() as any,
    scope: defaultScope,
    config: makeConfig(),
    logger,
    dryRun: false,
  });

  assertEqual(result.promotions.length, 0, "no promotions");
  assertTrue(logger.warns.some((w) => w.includes("memory not found in backend")), "warning logged");
});

// 8. already promoted entry (promotedAt set) → filtered by scorer
await test("already-promoted entry is filtered by scorer", async () => {
  const scorer = new MockScorer();
  scorer.setScore("ft-promoted", 0.8);

  const signals = new MockSignalStore();
  signals.add(baseEntry({ key: "ft-promoted", promotedAt: Date.now() }));

  const logger = createLogger();

  const result = await runDeepPhase({
    candidates: signals.getAll(),
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: signals as any,
    scorer: scorer as any,
    coreRepo: new MockCoreRepo() as any,
    freeTextBackend: new MockFreeTextBackend() as any,
    scope: defaultScope,
    config: makeConfig(),
    logger,
    dryRun: false,
  });

  assertEqual(result.promotions.length, 0, "no promotions");
  assertEqual(result.highScoreCount, 0, "highScoreCount");
  assertTrue(logger.logs.some((l) => l.includes("already promoted")), "already promoted logged");
});

// 9. 0 candidates → empty promotions, totalScored=0
await test("zero candidates returns empty result", async () => {
  const result = await runDeepPhase({
    candidates: [],
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: new MockSignalStore() as any,
    scorer: new MockScorer() as any,
    coreRepo: new MockCoreRepo() as any,
    freeTextBackend: new MockFreeTextBackend() as any,
    scope: defaultScope,
    config: makeConfig(),
    logger: createLogger(),
    dryRun: false,
  });

  assertEqual(result.promotions.length, 0, "promotions empty");
  assertEqual(result.totalScored, 0, "totalScored is 0");
  assertEqual(result.highScoreCount, 0, "highScoreCount is 0");
});

// 10. promoted entry targetKey format is dreaming.xxxx
await test("promoted entry targetKey has dreaming. prefix", async () => {
  const scorer = new MockScorer();
  scorer.setScore("ft-target", 0.8);

  const signals = new MockSignalStore();
  signals.add(baseEntry({ key: "ft-target" }));

  const backend = new MockFreeTextBackend();
  backend.memories = [{ id: "ft-target", text: "text", category: "general", source: "memu_item", scope: defaultScope }];

  const result = await runDeepPhase({
    candidates: signals.getAll(),
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: signals as any,
    scorer: scorer as any,
    coreRepo: new MockCoreRepo() as any,
    freeTextBackend: backend as any,
    scope: defaultScope,
    config: makeConfig(),
    logger: createLogger(),
    dryRun: false,
  });

  assertEqual(result.promotions[0].targetKey, "dreaming.ft-target", "targetKey format");
});

// 11. dryRun=true targetKey still computed (not undefined)
await test("dryRun still computes targetKey without upsert", async () => {
  const scorer = new MockScorer();
  scorer.setScore("ft-dry-target", 0.8);

  const signals = new MockSignalStore();
  signals.add(baseEntry({ key: "ft-dry-target" }));

  const backend = new MockFreeTextBackend();
  backend.memories = [{ id: "ft-dry-target", text: "text", category: "general", source: "memu_item", scope: defaultScope }];

  const result = await runDeepPhase({
    candidates: signals.getAll(),
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: signals as any,
    scorer: scorer as any,
    coreRepo: new MockCoreRepo() as any,
    freeTextBackend: backend as any,
    scope: defaultScope,
    config: makeConfig(),
    logger: createLogger(),
    dryRun: true,
  });

  assertTrue(result.promotions[0].targetKey !== undefined, "targetKey defined");
  assertTrue(result.promotions[0].targetKey.startsWith("dreaming."), "targetKey starts with dreaming.");
});

// 12. promoted memory importance >= 0.75
await test("promoted memory importance is >= 0.75", async () => {
  const scorer = new MockScorer();
  scorer.setScore("ft-imp", 0.82);

  const signals = new MockSignalStore();
  signals.add(baseEntry({ key: "ft-imp" }));

  const backend = new MockFreeTextBackend();
  backend.memories = [{ id: "ft-imp", text: "text", category: "general", source: "memu_item", scope: defaultScope }];

  const coreRepo = new MockCoreRepo();

  await runDeepPhase({
    candidates: signals.getAll(),
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: signals as any,
    scorer: scorer as any,
    coreRepo: coreRepo as any,
    freeTextBackend: backend as any,
    scope: defaultScope,
    config: makeConfig(),
    logger: createLogger(),
    dryRun: false,
  });

  assertEqual(coreRepo.upserts.length, 1, "upsert called");
  assertTrue(coreRepo.upserts[0].payload.importance >= 0.75, "importance >= 0.75");
  assertEqual(coreRepo.upserts[0].payload.importance, 0.82, "importance equals score");
});

// 13. same memory ID across two cycles → second skipped due to promotedAt
await test("same memory across two cycles is idempotent", async () => {
  const scorer = new MockScorer();
  scorer.setScore("ft-idem", 0.8);

  const signals = new MockSignalStore();
  signals.add(baseEntry({ key: "ft-idem" }));

  const backend = new MockFreeTextBackend();
  backend.memories = [{ id: "ft-idem", text: "text", category: "general", source: "memu_item", scope: defaultScope }];

  // First cycle
  const result1 = await runDeepPhase({
    candidates: signals.getAll(),
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: signals as any,
    scorer: scorer as any,
    coreRepo: new MockCoreRepo() as any,
    freeTextBackend: backend as any,
    scope: defaultScope,
    config: makeConfig(),
    logger: createLogger(),
    dryRun: false,
  });

  assertEqual(result1.promotions.length, 1, "first cycle promotes");
  assertTrue(signals.promotedKeys.includes("ft-idem"), "marked promoted after first cycle");

  // Second cycle: same candidate (now with promotedAt)
  const logger2 = createLogger();
  const result2 = await runDeepPhase({
    candidates: signals.getAll(),
    phaseSignals: new MockPhaseSignalStore() as any,
    signals: signals as any,
    scorer: scorer as any,
    coreRepo: new MockCoreRepo() as any,
    freeTextBackend: backend as any,
    scope: defaultScope,
    config: makeConfig(),
    logger: logger2,
    dryRun: false,
  });

  assertEqual(result2.promotions.length, 0, "second cycle skips");
  assertTrue(logger2.logs.some((l) => l.includes("already promoted")), "second cycle logs already promoted");
});

// -- Summary --
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
