// ============================================================================
// Dreaming Runner Integration Tests
// Run with: npx tsx tests/dreaming-runner.test.ts
// ============================================================================

import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConsolidationRunner } from "../consolidation/runner.js";
import { RecallSignalStore } from "../consolidation/signal-store.js";
import { PhaseSignalStore } from "../consolidation/phase-signal-store.js";
import type { DreamingConfig, MemoryScope, MemuMemoryRecord } from "../types.js";
import type { CoreMemoryRepository } from "../core-repository.js";
import type { FreeTextBackend } from "../backends/free-text/base.js";

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

function createBaseDreamingConfig(tmpDir: string): DreamingConfig {
  return {
    enabled: true,
    schedule: { hourOfDay: 4 },
    signalStorePath: join(tmpDir, "signals.json"),
    phaseSignalStorePath: join(tmpDir, "phase-signals.json"),
    diaryPath: join(tmpDir, "diary.jsonl"),
    scoring: {
      weights: { frequency: 0.24, relevance: 0.30, diversity: 0.15, recency: 0.15, consolidation: 0.10, conceptual: 0.06 },
      promotion: { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 2 },
    },
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
}

function createMockCoreRepo(): { repo: CoreMemoryRepository; upsertCalls: unknown[] } {
  const upsertCalls: unknown[] = [];
  const repo = {
    list: async () => [],
    upsert: async (_scope: MemoryScope, payload: unknown) => { upsertCalls.push(payload); },
    delete: async () => {},
    touch: async () => {},
    consolidate: async () => {},
  } as unknown as CoreMemoryRepository;
  return { repo, upsertCalls };
}

function createMockFreeTextBackend(records: MemuMemoryRecord[]): FreeTextBackend {
  return {
    provider: "mock",
    healthCheck: async () => ({ provider: "mock", healthy: true }),
    store: async () => true,
    search: async () => [],
    list: async () => records,
    forget: async () => ({ purged_categories: 0, purged_items: 0, purged_resources: 0 }),
  } as unknown as FreeTextBackend;
}

console.log("\nDreaming Runner Tests\n");

// ── Test 1: empty signal store ──────────────────────────────────────────────
await test("empty signal store returns zero report", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-runner-"));
  const config = createBaseDreamingConfig(tmpDir);
  const signalStore = new RecallSignalStore(config.signalStorePath, config, testLogger);
  const phaseSignalStore = new PhaseSignalStore(config.phaseSignalStorePath);
  await signalStore.load();
  await phaseSignalStore.load();

  const { repo } = createMockCoreRepo();
  const backend = createMockFreeTextBackend([]);
  const runner = new ConsolidationRunner(repo, {} as any, testLogger, backend, {
    signalStore,
    phaseSignalStore,
    dreamingConfig: config,
  });

  const report = await runner.runDreaming(testScope, false);

  assertEqual(report.candidatesEvaluated, 0, "candidatesEvaluated");
  assertEqual(report.promotions.length, 0, "promotions");
  assertEqual(report.patternsDetected, 0, "patternsDetected");
  assertEqual(report.signalBoosts, 0, "signalBoosts");

  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 2: 5 signal entries (2 eligible) ───────────────────────────────────
await test("5 signal entries with 2 eligible promotions", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-runner-"));
  const config = createBaseDreamingConfig(tmpDir);
  const signalStore = new RecallSignalStore(config.signalStorePath, config, testLogger);
  const phaseSignalStore = new PhaseSignalStore(config.phaseSignalStorePath);
  await signalStore.load();
  await phaseSignalStore.load();

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // 3 ineligible entries (low recallCount / low score)
  for (let i = 1; i <= 3; i++) {
    signalStore.recordRecall({
      key: `low-mem-${i}`,
      layer: "free-text",
      snippet: `low value ${i}`,
      queryHash: `qh${i}`,
      relevanceScore: 0.1,
      conceptTags: ["a"],
    });
  }

  // 2 eligible entries (high recallCount, high score) with distinct snippets
  const eligibleEntries = [
    { key: "elig-1", snippet: "alpha project requirements document" },
    { key: "elig-2", snippet: "beta release schedule calendar" },
  ];
  for (const { key, snippet } of eligibleEntries) {
    for (let q = 1; q <= 3; q++) {
      signalStore.recordRecall({
        key,
        layer: "free-text",
        snippet,
        queryHash: `hash${q}`,
        relevanceScore: 0.9,
        conceptTags: ["tag1", "tag2", "tag3"],
      });
    }
    // bump lastRecalledAt to now by recording one more
    signalStore.recordRecall({
      key,
      layer: "free-text",
      snippet,
      queryHash: `hash4`,
      relevanceScore: 0.9,
      conceptTags: ["tag4", "tag5", "tag6"],
    });
  }

  // Override firstRecalledAt for eligible entries to ensure cross-day consolidation is high
  for (const { key, snippet } of eligibleEntries) {
    const entry = signalStore.get(key)!;
    entry.firstRecalledAt = now - 86400000 * 3;
    entry.lastRecalledAt = now;
    entry.recallDays = ["2026-04-09", "2026-04-10", "2026-04-11", today];
    entry.recallCount = 5;
    entry.totalScore = 4.5;
    entry.queryHashes = ["h1", "h2", "h3", "h4"];
  }

  const ftRecords: MemuMemoryRecord[] = eligibleEntries.map(({ key, snippet }) => ({
    id: key,
    text: snippet,
    category: "general",
    source: "memu_item",
    scope: testScope,
    score: 0.9,
  }));

  await signalStore.flush();
  await phaseSignalStore.flush();

  const { repo, upsertCalls } = createMockCoreRepo();
  const backend = createMockFreeTextBackend(ftRecords);
  const runner = new ConsolidationRunner(repo, {} as any, testLogger, backend, {
    signalStore,
    phaseSignalStore,
    dreamingConfig: config,
  });

  const report = await runner.runDreaming(testScope, false);

  assert(report.promotions.length >= 2, `expected >=2 promotions, got ${report.promotions.length}`);
  const promotedKeys = report.promotions.map((p) => p.sourceKey);
  assert(promotedKeys.includes("elig-1"), "elig-1 promoted");
  assert(promotedKeys.includes("elig-2"), "elig-2 promoted");
  assert(report.promotions.every((p) => p.score >= 0.75), "all promoted scores >= 0.75");

  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 3: dryRun=true does not call upsert ────────────────────────────────
await test("dryRun=true calculates promotions but skips upsert", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-runner-"));
  const config = createBaseDreamingConfig(tmpDir);
  const signalStore = new RecallSignalStore(config.signalStorePath, config, testLogger);
  const phaseSignalStore = new PhaseSignalStore(config.phaseSignalStorePath);
  await signalStore.load();
  await phaseSignalStore.load();

  const now = Date.now();
  const key = "dryrun-mem";
  for (let i = 1; i <= 5; i++) {
    signalStore.recordRecall({
      key,
      layer: "free-text",
      snippet: "dry run memory",
      queryHash: `h${i}`,
      relevanceScore: 0.95,
      conceptTags: ["a", "b", "c"],
    });
  }
  const entry = signalStore.get(key)!;
  entry.lastRecalledAt = now;
  entry.recallDays = ["2026-04-09", "2026-04-10", "2026-04-11", "2026-04-12"];
  entry.totalScore = 4.75;

  const ftRecords: MemuMemoryRecord[] = [{
    id: key,
    text: "dry run memory",
    category: "general",
    source: "memu_item",
    scope: testScope,
    score: 0.95,
  }];

  await signalStore.flush();
  await phaseSignalStore.flush();

  const { repo, upsertCalls } = createMockCoreRepo();
  const backend = createMockFreeTextBackend(ftRecords);
  const runner = new ConsolidationRunner(repo, {} as any, testLogger, backend, {
    signalStore,
    phaseSignalStore,
    dreamingConfig: config,
  });

  const report = await runner.runDreaming(testScope, true);

  assert(report.promotions.length > 0, "promotions calculated");
  assertEqual(upsertCalls.length, 0, "upsert should not be called in dryRun");

  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 4: stores flushed after run ────────────────────────────────────────
await test("stores are flushed to disk after runDreaming", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-runner-"));
  const config = createBaseDreamingConfig(tmpDir);
  const signalStore = new RecallSignalStore(config.signalStorePath, config, testLogger);
  const phaseSignalStore = new PhaseSignalStore(config.phaseSignalStorePath);
  await signalStore.load();
  await phaseSignalStore.load();

  signalStore.recordRecall({
    key: "flush-mem",
    layer: "free-text",
    snippet: "flush test",
    queryHash: "h1",
    relevanceScore: 0.5,
    conceptTags: ["x"],
  });

  const { repo } = createMockCoreRepo();
  const backend = createMockFreeTextBackend([]);
  const runner = new ConsolidationRunner(repo, {} as any, testLogger, backend, {
    signalStore,
    phaseSignalStore,
    dreamingConfig: config,
  });

  await runner.runDreaming(testScope, false);

  await access(config.signalStorePath);
  await access(config.phaseSignalStorePath);

  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 5: phase signals accumulate across two runs ────────────────────────
await test("phase signals accumulate across two runDreaming calls", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-runner-"));
  const config = createBaseDreamingConfig(tmpDir);
  const signalStore = new RecallSignalStore(config.signalStorePath, config, testLogger);
  const phaseSignalStore = new PhaseSignalStore(config.phaseSignalStorePath);
  await signalStore.load();
  await phaseSignalStore.load();

  const now = Date.now();
  const key = "phase-mem";
  // Base score ~0.719, needs phaseBoost to cross 0.75
  for (let i = 1; i <= 5; i++) {
    signalStore.recordRecall({
      key,
      layer: "free-text",
      snippet: "phase boost memory",
      queryHash: `h${i}`,
      relevanceScore: 0.72,
      conceptTags: ["a", "b", "c"],
    });
  }
  const entry = signalStore.get(key)!;
  entry.lastRecalledAt = now;
  entry.recallDays = ["2026-04-10", "2026-04-11", "2026-04-12"];
  entry.totalScore = 3.6; // 3.6/5 = 0.72 relevance
  entry.queryHashes = ["h1", "h2", "h3"];

  const ftRecords: MemuMemoryRecord[] = [{
    id: key,
    text: "phase boost memory",
    category: "general",
    source: "memu_item",
    scope: testScope,
    score: 0.72,
  }];

  await signalStore.flush();
  await phaseSignalStore.flush();

  const { repo, upsertCalls } = createMockCoreRepo();
  const backend = createMockFreeTextBackend(ftRecords);
  const runner = new ConsolidationRunner(repo, {} as any, testLogger, backend, {
    signalStore,
    phaseSignalStore,
    dreamingConfig: config,
  });

  // First run: no prior lightHits, base score + 1 lightBoost (~0.017) < 0.75 → not promoted
  const report1 = await runner.runDreaming(testScope, false);
  assertEqual(report1.promotions.length, 0, "first run should not promote");

  // Need to reload stores from disk to simulate fresh start
  await signalStore.load();
  await phaseSignalStore.load();

  // Second run: 2 lightHits total → lightBoost ~0.033, score ~0.752 → promoted
  const report2 = await runner.runDreaming(testScope, false);
  assert(report2.promotions.length > 0, "second run should promote due to accumulated phase signals");
  assert(upsertCalls.length > 0, "upsert called on second run");

  await rm(tmpDir, { recursive: true, force: true });
});

// ── Test 6: prune executed after run ends ───────────────────────────────────
await test("prune is executed after runDreaming ends", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "dream-runner-"));
  const config: DreamingConfig = {
    ...createBaseDreamingConfig(tmpDir),
    maxSignalEntries: 2,
  };
  const signalStore = new RecallSignalStore(config.signalStorePath, config, testLogger);
  const phaseSignalStore = new PhaseSignalStore(config.phaseSignalStorePath);
  await signalStore.load();
  await phaseSignalStore.load();

  // Seed 4 signal entries (over the max of 2)
  for (let i = 1; i <= 4; i++) {
    signalStore.recordRecall({
      key: `prune-mem-${i}`,
      layer: "free-text",
      snippet: `prune test ${i}`,
      queryHash: `h${i}`,
      relevanceScore: 0.1,
      conceptTags: ["x"],
    });
  }

  // Seed a phase signal for a key that won't survive light phase
  phaseSignalStore.recordLightHit("orphan-key");

  const { repo } = createMockCoreRepo();
  const backend = createMockFreeTextBackend([]);
  const runner = new ConsolidationRunner(repo, {} as any, testLogger, backend, {
    signalStore,
    phaseSignalStore,
    dreamingConfig: config,
  });

  await runner.runDreaming(testScope, false);

  assert(signalStore.size <= 2, `signalStore.size should be <= 2 after prune, got ${signalStore.size}`);
  assert(phaseSignalStore.get("orphan-key") === undefined, "orphan phase signal should be pruned");

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
