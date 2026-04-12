// ============================================================================
// Dreaming Scheduler Integration Tests
// Run with: npx tsx tests/dreaming-scheduler.test.ts
// ============================================================================

import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConsolidationScheduler } from "../consolidation/scheduler.js";
import { ConsolidationRunner } from "../consolidation/runner.js";
import { RecallSignalStore } from "../consolidation/signal-store.js";
import { PhaseSignalStore } from "../consolidation/phase-signal-store.js";
import type { ConsolidationConfig, DreamingConfig, MemoryScope } from "../types.js";
import type { CoreMemoryRepository } from "../core-repository.js";

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

function assertEqual(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const testScope: MemoryScope = {
  userId: "test_user",
  agentId: "test_agent",
  sessionKey: "agent:test_agent",
};

const testLogger = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
};

function createBaseConfig(tmpDir: string): ConsolidationConfig {
  return {
    enabled: true,
    intervalMs: 3_600_000,
    similarityThreshold: 0.85,
    thresholds: { keep: 0.65, downgrade: 0.45, archive: 0.25, delete: 0.10, llmLow: 0.35, llmHigh: 0.55 },
    decay: { stabilityDays: 14 },
    weights: { recency: 0.30, accessFreq: 0.20, novelty: 0.20, typePrior: 0.15, explicitImportance: 0.15 },
    schedule: {
      daily: { enabled: false, hourOfDay: 3 },
      weekly: { enabled: false, hourOfDay: 4, dayOfWeek: 1 },
      monthly: { enabled: false, hourOfDay: 5, dayOfMonth: 1 },
    },
    llm: { enabled: false, apiBase: "", model: "", timeoutMs: 30_000, maxBatchSize: 20 },
    deadLetterPath: join(tmpDir, "dead-letter.jsonl"),
    statePath: join(tmpDir, "state.json"),
  };
}

function createMockRunner(): {
  runner: ConsolidationRunner;
  runDreamingCalls: Array<{ scope: MemoryScope; dryRun: boolean }>;
  setRunDreamingDelay: (ms: number) => void;
  resolveDelay: (() => void) | undefined;
} {
  const runDreamingCalls: Array<{ scope: MemoryScope; dryRun: boolean }> = [];
  let delayMs = 0;
  let resolveDelay: (() => void) | undefined;

  const runner = {
    run: async () => ({
      cycle: "daily",
      runAt: new Date().toISOString(),
      dryRun: false,
      totalScored: 0,
      kept: 0,
      downgraded: 0,
      merged: 0,
      archived: 0,
      deleted: 0,
      llmCalled: false,
      entries: [],
    }),
    runDreaming: async (scope: MemoryScope, dryRun: boolean) => {
      runDreamingCalls.push({ scope, dryRun });
      if (delayMs > 0) {
        await new Promise<void>((r) => { resolveDelay = r; setTimeout(r, delayMs); });
      }
      return {
        phase: "all" as const,
        runAt: new Date().toISOString(),
        candidatesEvaluated: 1,
        promotions: [],
        patternsDetected: 0,
        signalBoosts: 0,
      };
    },
  } as unknown as ConsolidationRunner;

  return {
    runner,
    runDreamingCalls,
    setRunDreamingDelay: (ms: number) => { delayMs = ms; },
    resolveDelay,
  };
}

function mockDateHours(hour: number, dateStr = "2026-04-12"): () => void {
  const originalGetHours = Date.prototype.getHours;
  const originalGetDay = Date.prototype.getDay;
  const originalGetDate = Date.prototype.getDate;
  const originalGetFullYear = Date.prototype.getFullYear;
  const originalGetMonth = Date.prototype.getMonth;

  Date.prototype.getHours = function () { return hour; };
  Date.prototype.getDay = function () { return 0; }; // Sunday
  Date.prototype.getDate = function () { return 12; };
  Date.prototype.getFullYear = function () { return 2026; };
  Date.prototype.getMonth = function () { return 3; }; // April

  return () => {
    Date.prototype.getHours = originalGetHours;
    Date.prototype.getDay = originalGetDay;
    Date.prototype.getDate = originalGetDate;
    Date.prototype.getFullYear = originalGetFullYear;
    Date.prototype.getMonth = originalGetMonth;
  };
}

console.log("\nDreaming Scheduler Tests\n");

// ── Test 7: tick at dreaming hour triggers runDreaming ──────────────────────
await test("tick at dreaming hour calls runDreaming", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-sched-"));
  const dreaming: DreamingConfig = {
    enabled: true,
    schedule: { hourOfDay: 4 },
    signalStorePath: "",
    phaseSignalStorePath: "",
    diaryPath: "",
    scoring: { weights: { frequency: 0.24, relevance: 0.30, diversity: 0.15, recency: 0.15, consolidation: 0.10, conceptual: 0.06 }, promotion: { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 2 } },
    maxSignalEntries: 500,
    maxQueryHashes: 32,
    maxRecallDays: 16,
    maxPromotionsPerCycle: 5,
    maxConceptTags: 20,
    dedupeThreshold: 0.85,
    llmDiary: false,
    timezone: "UTC",
    normalizeWeights: true,
  };
  const config = createBaseConfig(tmpDir);
  const { runner, runDreamingCalls } = createMockRunner();
  const scheduler = new ConsolidationScheduler(runner, config, testScope, testLogger, dreaming);

  const restore = mockDateHours(4);
  await (scheduler as any).tick();
  restore();

  await new Promise((r) => setTimeout(r, 50));
  assertEqual(runDreamingCalls.length, 1, "runDreaming should be called once");

  await scheduler.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 8: tick at non-dreaming hour does not trigger ──────────────────────
await test("tick at non-dreaming hour does not trigger", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-sched-"));
  const dreaming: DreamingConfig = {
    enabled: true,
    schedule: { hourOfDay: 4 },
    signalStorePath: "",
    phaseSignalStorePath: "",
    diaryPath: "",
    scoring: { weights: { frequency: 0.24, relevance: 0.30, diversity: 0.15, recency: 0.15, consolidation: 0.10, conceptual: 0.06 }, promotion: { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 2 } },
    maxSignalEntries: 500,
    maxQueryHashes: 32,
    maxRecallDays: 16,
    maxPromotionsPerCycle: 5,
    maxConceptTags: 20,
    dedupeThreshold: 0.85,
    llmDiary: false,
    timezone: "UTC",
    normalizeWeights: true,
  };
  const config = createBaseConfig(tmpDir);
  const { runner, runDreamingCalls } = createMockRunner();
  const scheduler = new ConsolidationScheduler(runner, config, testScope, testLogger, dreaming);

  const restore = mockDateHours(5);
  await (scheduler as any).tick();
  restore();

  await new Promise((r) => setTimeout(r, 50));
  assertEqual(runDreamingCalls.length, 0, "runDreaming should not be called");

  await scheduler.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 9: lastDreamingRun persisted to state file ─────────────────────────
await test("lastDreamingRun is persisted to state file", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-sched-"));
  const dreaming: DreamingConfig = {
    enabled: true,
    schedule: { hourOfDay: 4 },
    signalStorePath: "",
    phaseSignalStorePath: "",
    diaryPath: "",
    scoring: { weights: { frequency: 0.24, relevance: 0.30, diversity: 0.15, recency: 0.15, consolidation: 0.10, conceptual: 0.06 }, promotion: { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 2 } },
    maxSignalEntries: 500,
    maxQueryHashes: 32,
    maxRecallDays: 16,
    maxPromotionsPerCycle: 5,
    maxConceptTags: 20,
    dedupeThreshold: 0.85,
    llmDiary: false,
    timezone: "UTC",
    normalizeWeights: true,
  };
  const config = createBaseConfig(tmpDir);
  const { runner } = createMockRunner();
  const scheduler = new ConsolidationScheduler(runner, config, testScope, testLogger, dreaming);

  const restore = mockDateHours(4);
  await scheduler.forceRun("dreaming", false);
  restore();

  const raw = await readFile(config.statePath, "utf-8");
  const state = JSON.parse(raw);
  assert(typeof state.lastDreamingRun === "string", "lastDreamingRun should be a string");
  assert(state.lastDreamingRun.length > 0, "lastDreamingRun should not be empty");

  await scheduler.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 10: duplicate tick same hour is idempotent ─────────────────────────
await test("duplicate tick in same hour does not re-trigger", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-sched-"));
  const dreaming: DreamingConfig = {
    enabled: true,
    schedule: { hourOfDay: 4 },
    signalStorePath: "",
    phaseSignalStorePath: "",
    diaryPath: "",
    scoring: { weights: { frequency: 0.24, relevance: 0.30, diversity: 0.15, recency: 0.15, consolidation: 0.10, conceptual: 0.06 }, promotion: { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 2 } },
    maxSignalEntries: 500,
    maxQueryHashes: 32,
    maxRecallDays: 16,
    maxPromotionsPerCycle: 5,
    maxConceptTags: 20,
    dedupeThreshold: 0.85,
    llmDiary: false,
    timezone: "UTC",
    normalizeWeights: true,
  };
  const config = createBaseConfig(tmpDir);
  const { runner, runDreamingCalls } = createMockRunner();
  const scheduler = new ConsolidationScheduler(runner, config, testScope, testLogger, dreaming);

  // Pre-seed state with lastDreamingRun at hour 4
  const now = new Date();
  now.setHours(4, 0, 0, 0);
  await writeFile(config.statePath, JSON.stringify({ totalRuns: 0, lastDreamingRun: now.toISOString() }), "utf-8");

  const restore = mockDateHours(4);
  await (scheduler as any).tick();
  restore();

  await new Promise((r) => setTimeout(r, 50));
  assertEqual(runDreamingCalls.length, 0, "runDreaming should not be called again");

  await scheduler.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 11: forceRun dreaming executes ─────────────────────────────────────
await test("forceRun dreaming executes runDreaming", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-sched-"));
  const dreaming: DreamingConfig = {
    enabled: true,
    schedule: { hourOfDay: 4 },
    signalStorePath: "",
    phaseSignalStorePath: "",
    diaryPath: "",
    scoring: { weights: { frequency: 0.24, relevance: 0.30, diversity: 0.15, recency: 0.15, consolidation: 0.10, conceptual: 0.06 }, promotion: { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 2 } },
    maxSignalEntries: 500,
    maxQueryHashes: 32,
    maxRecallDays: 16,
    maxPromotionsPerCycle: 5,
    maxConceptTags: 20,
    dedupeThreshold: 0.85,
    llmDiary: false,
    timezone: "UTC",
    normalizeWeights: true,
  };
  const config = createBaseConfig(tmpDir);
  const { runner, runDreamingCalls } = createMockRunner();
  const scheduler = new ConsolidationScheduler(runner, config, testScope, testLogger, dreaming);

  await scheduler.forceRun("dreaming", false);
  assertEqual(runDreamingCalls.length, 1, "runDreaming should be called via forceRun");

  await scheduler.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 12: dreaming.enabled false never triggers ──────────────────────────
await test("dreaming.enabled false prevents tick trigger", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-sched-"));
  const dreaming: DreamingConfig = {
    enabled: false,
    schedule: { hourOfDay: 4 },
    signalStorePath: "",
    phaseSignalStorePath: "",
    diaryPath: "",
    scoring: { weights: { frequency: 0.24, relevance: 0.30, diversity: 0.15, recency: 0.15, consolidation: 0.10, conceptual: 0.06 }, promotion: { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 2 } },
    maxSignalEntries: 500,
    maxQueryHashes: 32,
    maxRecallDays: 16,
    maxPromotionsPerCycle: 5,
    maxConceptTags: 20,
    dedupeThreshold: 0.85,
    llmDiary: false,
    timezone: "UTC",
    normalizeWeights: true,
  };
  const config = createBaseConfig(tmpDir);
  const { runner, runDreamingCalls } = createMockRunner();
  const scheduler = new ConsolidationScheduler(runner, config, testScope, testLogger, dreaming);

  const restore = mockDateHours(4);
  await (scheduler as any).tick();
  restore();

  await new Promise((r) => setTimeout(r, 50));
  assertEqual(runDreamingCalls.length, 0, "runDreaming should not be called when disabled");

  await scheduler.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 13: concurrent runDreaming returns empty report ────────────────────
await test("concurrent runDreaming returns empty report due to inflight guard", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-runner-"));
  const dreaming: DreamingConfig = {
    enabled: true,
    schedule: { hourOfDay: 4 },
    signalStorePath: join(tmpDir, "signals.json"),
    phaseSignalStorePath: join(tmpDir, "phase-signals.json"),
    diaryPath: join(tmpDir, "diary.jsonl"),
    scoring: { weights: { frequency: 0.24, relevance: 0.30, diversity: 0.15, recency: 0.15, consolidation: 0.10, conceptual: 0.06 }, promotion: { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 2 } },
    maxSignalEntries: 500,
    maxQueryHashes: 32,
    maxRecallDays: 16,
    maxPromotionsPerCycle: 5,
    maxConceptTags: 20,
    dedupeThreshold: 0.85,
    llmDiary: false,
    timezone: "UTC",
    normalizeWeights: true,
  };

  const signalStore = new RecallSignalStore(dreaming.signalStorePath, dreaming, testLogger);
  const phaseSignalStore = new PhaseSignalStore(dreaming.phaseSignalStorePath);
  await signalStore.load();
  await phaseSignalStore.load();

  // Seed one entry so runDreaming takes time (it will run through phases)
  signalStore.recordRecall({
    key: "slow-mem",
    layer: "free-text",
    snippet: "slow memory",
    queryHash: "h1",
    relevanceScore: 0.5,
    conceptTags: ["x"],
  });

  const repo = {
    list: async () => [],
    upsert: async () => { await new Promise((r) => setTimeout(r, 100)); },
    delete: async () => {},
    touch: async () => {},
    consolidate: async () => {},
  } as unknown as CoreMemoryRepository;

  const backend = {
    provider: "mock",
    healthCheck: async () => ({ provider: "mock", healthy: true }),
    store: async () => true,
    search: async () => [],
    list: async () => [],
    forget: async () => ({ purged_categories: 0, purged_items: 0, purged_resources: 0 }),
  } as any;

  const runner = new ConsolidationRunner(repo, {} as any, testLogger, backend, {
    signalStore,
    phaseSignalStore,
    dreamingConfig: dreaming,
  });

  const p1 = runner.runDreaming(testScope, false);
  const p2 = runner.runDreaming(testScope, false);

  const [r1, r2] = await Promise.all([p1, p2]);

  // One should be empty (the second), the other normal
  const emptyReport = r2.candidatesEvaluated === 0 && r2.promotions.length === 0;
  assert(emptyReport, "second concurrent runDreaming should return empty report");
  assert(r1.candidatesEvaluated >= 0, "first runDreaming should complete normally");

  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 14: lastDreamingRun written BEFORE cycle starts ────────────────────
await test("lastDreamingRun is written before dream cycle starts", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-sched-"));
  const dreaming: DreamingConfig = {
    enabled: true,
    schedule: { hourOfDay: 4 },
    signalStorePath: "",
    phaseSignalStorePath: "",
    diaryPath: "",
    scoring: { weights: { frequency: 0.24, relevance: 0.30, diversity: 0.15, recency: 0.15, consolidation: 0.10, conceptual: 0.06 }, promotion: { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 2 } },
    maxSignalEntries: 500,
    maxQueryHashes: 32,
    maxRecallDays: 16,
    maxPromotionsPerCycle: 5,
    maxConceptTags: 20,
    dedupeThreshold: 0.85,
    llmDiary: false,
    timezone: "UTC",
    normalizeWeights: true,
  };
  const config = createBaseConfig(tmpDir);

  let midRunStateHasTimestamp = false;
  const { runner, setRunDreamingDelay } = createMockRunner();
  setRunDreamingDelay(150);

  // Wrap runDreaming to check state mid-flight
  const originalRunDreaming = runner.runDreaming.bind(runner);
  runner.runDreaming = async (scope, dryRun) => {
    const raw = await readFile(config.statePath, "utf-8");
    const state = JSON.parse(raw);
    midRunStateHasTimestamp = typeof state.lastDreamingRun === "string" && state.lastDreamingRun.length > 0;
    return originalRunDreaming(scope, dryRun);
  };

  const scheduler = new ConsolidationScheduler(runner, config, testScope, testLogger, dreaming);

  const restore = mockDateHours(4);
  const forcePromise = scheduler.forceRun("dreaming", false);
  // Give enough time for the scheduler to write state and invoke runDreaming
  await new Promise((r) => setTimeout(r, 50));
  restore();

  await forcePromise;
  assert(midRunStateHasTimestamp, "lastDreamingRun should be written before runDreaming completes");

  await scheduler.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 15: periodic flush paused during cycle and resumed after ───────────
await test("periodic flush is paused during cycle and resumed after", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-runner-"));
  const dreaming: DreamingConfig = {
    enabled: true,
    schedule: { hourOfDay: 4 },
    signalStorePath: join(tmpDir, "signals.json"),
    phaseSignalStorePath: join(tmpDir, "phase-signals.json"),
    diaryPath: join(tmpDir, "diary.jsonl"),
    scoring: { weights: { frequency: 0.24, relevance: 0.30, diversity: 0.15, recency: 0.15, consolidation: 0.10, conceptual: 0.06 }, promotion: { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 2 } },
    maxSignalEntries: 500,
    maxQueryHashes: 32,
    maxRecallDays: 16,
    maxPromotionsPerCycle: 5,
    maxConceptTags: 20,
    dedupeThreshold: 0.85,
    llmDiary: false,
    timezone: "UTC",
    normalizeWeights: true,
  };

  const signalStore = new RecallSignalStore(dreaming.signalStorePath, dreaming, testLogger);
  const phaseSignalStore = new PhaseSignalStore(dreaming.phaseSignalStorePath);
  await signalStore.load();
  await phaseSignalStore.load();

  const repo = {
    list: async () => [],
    upsert: async () => {},
    delete: async () => {},
    touch: async () => {},
    consolidate: async () => {},
  } as unknown as CoreMemoryRepository;

  const backend = {
    provider: "mock",
    healthCheck: async () => ({ provider: "mock", healthy: true }),
    store: async () => true,
    search: async () => [],
    list: async () => [],
    forget: async () => ({ purged_categories: 0, purged_items: 0, purged_resources: 0 }),
  } as any;

  const runner = new ConsolidationRunner(repo, {} as any, testLogger, backend, {
    signalStore,
    phaseSignalStore,
    dreamingConfig: dreaming,
  });

  let paused = false;
  let resumed = false;
  runner.setPauseResumeFlush(
    () => { paused = true; },
    () => { resumed = true; },
  );

  await runner.runDreaming(testScope, false);

  assert(paused, "pausePeriodicFlush should be called");
  assert(resumed, "resumePeriodicFlush should be called");

  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 16: recall hook recordRecall safe during cycle ─────────────────────
await test("recordRecall works safely while runDreaming is in progress", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-runner-"));
  const dreaming: DreamingConfig = {
    enabled: true,
    schedule: { hourOfDay: 4 },
    signalStorePath: join(tmpDir, "signals.json"),
    phaseSignalStorePath: join(tmpDir, "phase-signals.json"),
    diaryPath: join(tmpDir, "diary.jsonl"),
    scoring: { weights: { frequency: 0.24, relevance: 0.30, diversity: 0.15, recency: 0.15, consolidation: 0.10, conceptual: 0.06 }, promotion: { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 2 } },
    maxSignalEntries: 500,
    maxQueryHashes: 32,
    maxRecallDays: 16,
    maxPromotionsPerCycle: 5,
    maxConceptTags: 20,
    dedupeThreshold: 0.85,
    llmDiary: false,
    timezone: "UTC",
    normalizeWeights: true,
  };

  const signalStore = new RecallSignalStore(dreaming.signalStorePath, dreaming, testLogger);
  const phaseSignalStore = new PhaseSignalStore(dreaming.phaseSignalStorePath);
  await signalStore.load();
  await phaseSignalStore.load();

  signalStore.recordRecall({
    key: "existing-mem",
    layer: "free-text",
    snippet: "existing memory",
    queryHash: "h1",
    relevanceScore: 0.9,
    conceptTags: ["a", "b", "c"],
  });
  const existingEntry = signalStore.get("existing-mem")!;
  existingEntry.recallCount = 5;
  existingEntry.totalScore = 4.5;
  existingEntry.queryHashes = ["h1", "h2", "h3", "h4"];
  existingEntry.recallDays = ["2026-04-09", "2026-04-10", "2026-04-11", "2026-04-12"];
  existingEntry.lastRecalledAt = Date.now();

  await signalStore.flush();

  const repo = {
    list: async () => [],
    upsert: async () => { await new Promise((r) => setTimeout(r, 150)); },
    delete: async () => {},
    touch: async () => {},
    consolidate: async () => {},
  } as unknown as CoreMemoryRepository;

  const backend = {
    provider: "mock",
    healthCheck: async () => ({ provider: "mock", healthy: true }),
    store: async () => true,
    search: async () => [],
    list: async () => [{ id: "existing-mem", text: "existing memory", category: "general", source: "memu_item", scope: testScope }],
    forget: async () => ({ purged_categories: 0, purged_items: 0, purged_resources: 0 }),
  } as any;

  const runner = new ConsolidationRunner(repo, {} as any, testLogger, backend, {
    signalStore,
    phaseSignalStore,
    dreamingConfig: dreaming,
  });

  const p1 = runner.runDreaming(testScope, false);

  // Wait briefly to ensure load() has completed and we're in the deep phase upsert delay
  await new Promise((r) => setTimeout(r, 50));

  // While runDreaming is still executing, record a new recall
  signalStore.recordRecall({
    key: "concurrent-mem",
    layer: "free-text",
    snippet: "concurrent",
    queryHash: "hc",
    relevanceScore: 0.8,
    conceptTags: ["y"],
  });

  await p1;

  const entry = signalStore.get("concurrent-mem");
  assert(entry !== undefined, "concurrent recordRecall should succeed");
  assertEqual(entry!.recallCount, 1, "recallCount should be 1");

  await rm(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Summary
// ============================================================================

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;

console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);

if (failed > 0) {
  console.log("\nFailed tests:");
  for (const r of results.filter((r) => !r.passed)) {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  }
  process.exit(1);
}
