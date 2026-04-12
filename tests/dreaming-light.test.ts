// ============================================================================
// Tests: Light Phase -- Deduplicate and Stage (DREAM-06)
// Run with: npx tsx tests/dreaming-light.test.ts
// ============================================================================

import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RecallSignalStore } from "../consolidation/signal-store.js";
import { PhaseSignalStore } from "../consolidation/phase-signal-store.js";
import { runLightPhase } from "../consolidation/dream-light.js";
import type { DreamingConfig } from "../types.js";

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

function assertSetsEqual(a: string[], b: string[], msg: string): void {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size || ![...sa].every((x) => sb.has(x))) {
    throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const baseConfig: DreamingConfig = {
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
  maxPromotionsPerCycle: 5,
  maxConceptTags: 20,
  dedupeThreshold: 0.85,
  llmDiary: false,
  timezone: "Asia/Shanghai",
  normalizeWeights: true,
};

const logger = { info: () => {}, warn: () => {} };

console.log("\nDreaming Light Phase Tests (DREAM-06)\n");

// Helper to create an isolated temp dir
async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memu-light-"));
}

// 1. Two identical snippets → merged, recallCount = sum
await test("two identical snippets → merged, recallCount = sum", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "hello world", queryHash: "h1", relevanceScore: 0.8, conceptTags: ["tag1"] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "hello world", queryHash: "h2", relevanceScore: 0.6, conceptTags: ["tag2"] });

  // Bump recallCount for a to 2, b stays at 1 from recordRecall
  signals.recordRecall({ key: "a", layer: "free-text", snippet: "hello world", queryHash: "h3", relevanceScore: 0.7, conceptTags: ["tag3"] });

  const result = await runLightPhase({ signals, phaseSignals, config: baseConfig, logger });

  assertEqual(result.candidates.length, 1, "candidates count");
  assertEqual(result.deduped, 1, "deduped count");
  assertEqual(result.candidates[0]?.recallCount, 3, "recallCount sum");
});

// 2. similarity < 0.85 → both kept
await test("similarity < 0.85 → both kept", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "completely different sentence one", queryHash: "h1", relevanceScore: 0.8, conceptTags: [] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "totally unrelated phrase number two", queryHash: "h2", relevanceScore: 0.6, conceptTags: [] });

  const result = await runLightPhase({ signals, phaseSignals, config: baseConfig, logger });

  assertEqual(result.candidates.length, 2, "candidates count");
  assertEqual(result.deduped, 0, "deduped count");
});

// 3. merged queryHashes union deduped
await test("merged queryHashes union deduped", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "duplicate text", queryHash: "aa", relevanceScore: 0.5, conceptTags: [] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "duplicate text", queryHash: "bb", relevanceScore: 0.5, conceptTags: [] });
  signals.recordRecall({ key: "c", layer: "free-text", snippet: "duplicate text", queryHash: "aa", relevanceScore: 0.5, conceptTags: [] });

  const result = await runLightPhase({ signals, phaseSignals, config: baseConfig, logger });

  assertEqual(result.candidates.length, 1, "candidates count");
  assertSetsEqual(result.candidates[0]!.queryHashes, ["aa", "bb"], "queryHashes union");
});

// 4. merged recallDays union deduped
await test("merged recallDays union deduped", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "same", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "same", queryHash: "h2", relevanceScore: 0.5, conceptTags: [] });

  // Manually override recallDays to specific values for deterministic test
  const all = signals.getAll();
  const entryA = all.find((e) => e.key === "a")!;
  const entryB = all.find((e) => e.key === "b")!;
  entryA.recallDays = ["2026-04-01", "2026-04-02"];
  entryB.recallDays = ["2026-04-02", "2026-04-03"];

  const result = await runLightPhase({ signals, phaseSignals, config: baseConfig, logger });

  assertEqual(result.candidates.length, 1, "candidates count");
  assertSetsEqual(result.candidates[0]!.recallDays, ["2026-04-01", "2026-04-02", "2026-04-03"], "recallDays union");
});

// 5. each surviving candidate gets lightHit
await test("each surviving candidate gets lightHit", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "candidate one", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "candidate two", queryHash: "h2", relevanceScore: 0.5, conceptTags: [] });

  const result = await runLightPhase({ signals, phaseSignals, config: baseConfig, logger });

  assertEqual(result.lightHitsRecorded, 2, "lightHitsRecorded");
  assertEqual(phaseSignals.get("a")?.lightHits, 1, "a lightHits");
  assertEqual(phaseSignals.get("b")?.lightHits, 1, "b lightHits");
});

// 6. empty signal store → empty result
await test("empty signal store → empty result", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  const result = await runLightPhase({ signals, phaseSignals, config: baseConfig, logger });

  assertEqual(result.candidates.length, 0, "candidates count");
  assertEqual(result.deduped, 0, "deduped count");
  assertEqual(result.lightHitsRecorded, 0, "lightHitsRecorded");
});

// 7. promoted entries excluded
await test("promoted entries excluded", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "promoted entry", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
  signals.markPromoted("a");

  const result = await runLightPhase({ signals, phaseSignals, config: baseConfig, logger });

  assertEqual(result.candidates.length, 0, "candidates count");
  assertEqual(result.deduped, 0, "deduped count");
});

// 8. three mutually similar → merge to 1 (transitivity via sorting)
await test("three mutually similar → merge to 1 (transitivity via sorting)", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  // a has highest recallCount so it will be the absorber
  signals.recordRecall({ key: "a", layer: "free-text", snippet: "common prefix value", queryHash: "h1", relevanceScore: 0.9, conceptTags: [] });
  signals.recordRecall({ key: "a", layer: "free-text", snippet: "common prefix value", queryHash: "h1b", relevanceScore: 0.9, conceptTags: [] });

  signals.recordRecall({ key: "b", layer: "free-text", snippet: "common prefix value extra", queryHash: "h2", relevanceScore: 0.8, conceptTags: [] });
  signals.recordRecall({ key: "c", layer: "free-text", snippet: "common prefix value more", queryHash: "h3", relevanceScore: 0.7, conceptTags: [] });

  const result = await runLightPhase({ signals, phaseSignals, config: baseConfig, logger });

  assertEqual(result.candidates.length, 1, "candidates count");
  assertEqual(result.deduped, 2, "deduped count");
  assertEqual(result.candidates[0]?.key, "a", "survivor is a");
  assertEqual(result.candidates[0]?.recallCount, 4, "recallCount sum (2+1+1)");
});

// 9. merged entries deleted from signal store
await test("merged entries deleted from signal store", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "delete test", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "delete test", queryHash: "h2", relevanceScore: 0.5, conceptTags: [] });

  assertEqual(signals.size, 2, "initial size");

  const result = await runLightPhase({ signals, phaseSignals, config: baseConfig, logger });

  assertEqual(result.deduped, 1, "deduped count");
  assertEqual(signals.size, 1, "size after merge");
  assert(signals.get("a") !== undefined, "a still exists");
  assert(signals.get("b") === undefined, "b was deleted");
});

// 10. CJK similar but different (< 0.85) → not merged
await test("CJK similar but different (< 0.85) → not merged", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "用户喜欢深色主题", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "用户偏好深色主题", queryHash: "h2", relevanceScore: 0.5, conceptTags: [] });

  const result = await runLightPhase({ signals, phaseSignals, config: baseConfig, logger });

  assertEqual(result.candidates.length, 2, "candidates count");
  assertEqual(result.deduped, 0, "deduped count");
});

// 11. CJK identical → similarity >= 0.85 → merged
await test("CJK identical → similarity >= 0.85 → merged", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "用户喜欢深色主题", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "用户喜欢深色主题", queryHash: "h2", relevanceScore: 0.5, conceptTags: [] });

  const result = await runLightPhase({ signals, phaseSignals, config: baseConfig, logger });

  assertEqual(result.candidates.length, 1, "candidates count");
  assertEqual(result.deduped, 1, "deduped count");
});

// Summary
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${passed}/${results.length} passed${failed > 0 ? `, ${failed} failed` : ""}`);
if (failed > 0) {
  process.exit(1);
}
