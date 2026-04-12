// ============================================================================
// Tests: REM Phase -- Pattern Detection and Signal Boosting (DREAM-08)
// Run with: npx tsx tests/dreaming-rem.test.ts
// ============================================================================

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RecallSignalStore } from "../consolidation/signal-store.js";
import { PhaseSignalStore } from "../consolidation/phase-signal-store.js";
import { runRemPhase } from "../consolidation/dream-rem.js";
import { LLMConsolidator } from "../consolidation/llm-consolidator.js";
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

console.log("\nDreaming REM Phase Tests (DREAM-08)\n");

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memu-rem-"));
}

// Helper to manually set recallDays on a signal-store entry
function setRecallDays(signals: RecallSignalStore, key: string, days: string[]): void {
  const entry = signals.get(key);
  if (entry) entry.recallDays = days;
}

// 1. 3 entries share tags ["ts", "test"] → 1 pattern, 3 remHits
await test("3 entries share tags → 1 pattern, 3 remHits", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "s1", queryHash: "h1", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "s2", queryHash: "h2", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  signals.recordRecall({ key: "c", layer: "free-text", snippet: "s3", queryHash: "h3", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  setRecallDays(signals, "a", ["2026-04-01", "2026-04-02"]);
  setRecallDays(signals, "b", ["2026-04-01", "2026-04-02"]);
  setRecallDays(signals, "c", ["2026-04-01", "2026-04-02"]);

  const result = await runRemPhase({ signals, phaseSignals, config: { ...baseConfig, diaryPath: join(dir, "diary.jsonl") }, logger });

  assertEqual(result.patternsDetected, 1, "patternsDetected");
  assertEqual(result.signalBoosts, 3, "signalBoosts");
  assertEqual(phaseSignals.get("a")?.remHits, 1, "a remHits");
  assertEqual(phaseSignals.get("b")?.remHits, 1, "b remHits");
  assertEqual(phaseSignals.get("c")?.remHits, 1, "c remHits");
  await rm(dir, { recursive: true, force: true });
});

// 2. 2 entries share tags → 0 patterns (below threshold 3)
await test("2 entries share tags → 0 patterns", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "s1", queryHash: "h1", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "s2", queryHash: "h2", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  setRecallDays(signals, "a", ["2026-04-01", "2026-04-02"]);
  setRecallDays(signals, "b", ["2026-04-01", "2026-04-02"]);

  const result = await runRemPhase({ signals, phaseSignals, config: { ...baseConfig, diaryPath: join(dir, "diary.jsonl") }, logger });

  assertEqual(result.patternsDetected, 0, "patternsDetected");
  assertEqual(result.signalBoosts, 0, "signalBoosts");
  await rm(dir, { recursive: true, force: true });
});

// 3. entry recallDays.length < 2 → in pattern but no remHit
await test("entry recallDays < 2 → in pattern but no remHit", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "s1", queryHash: "h1", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "s2", queryHash: "h2", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  signals.recordRecall({ key: "c", layer: "free-text", snippet: "s3", queryHash: "h3", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  setRecallDays(signals, "a", ["2026-04-01", "2026-04-02"]);
  setRecallDays(signals, "b", ["2026-04-01", "2026-04-02"]);
  setRecallDays(signals, "c", ["2026-04-01"]);

  const result = await runRemPhase({ signals, phaseSignals, config: { ...baseConfig, diaryPath: join(dir, "diary.jsonl") }, logger });

  assertEqual(result.patternsDetected, 1, "patternsDetected");
  assertEqual(result.signalBoosts, 2, "signalBoosts");
  assertEqual(phaseSignals.get("c")?.remHits, undefined, "c should not have remHit");
  await rm(dir, { recursive: true, force: true });
});

// 4. entry already REM hit before → remHits continue to accumulate
await test("existing remHit accumulates across cycles", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "s1", queryHash: "h1", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "s2", queryHash: "h2", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  signals.recordRecall({ key: "c", layer: "free-text", snippet: "s3", queryHash: "h3", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  setRecallDays(signals, "a", ["2026-04-01", "2026-04-02"]);
  setRecallDays(signals, "b", ["2026-04-01", "2026-04-02"]);
  setRecallDays(signals, "c", ["2026-04-01", "2026-04-02"]);

  // Pre-existing remHit
  phaseSignals.recordRemHit("a");
  assertEqual(phaseSignals.get("a")?.remHits, 1, "pre-existing remHits");

  const result = await runRemPhase({ signals, phaseSignals, config: { ...baseConfig, diaryPath: join(dir, "diary.jsonl") }, logger });

  assertEqual(result.patternsDetected, 1, "patternsDetected");
  assertEqual(result.signalBoosts, 3, "signalBoosts");
  assertEqual(phaseSignals.get("a")?.remHits, 2, "a remHits accumulated");
  await rm(dir, { recursive: true, force: true });
});

// 5. no LLM config → diary undefined, no error
await test("no LLM config → diary undefined", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "s1", queryHash: "h1", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "s2", queryHash: "h2", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  signals.recordRecall({ key: "c", layer: "free-text", snippet: "s3", queryHash: "h3", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  setRecallDays(signals, "a", ["2026-04-01", "2026-04-02"]);
  setRecallDays(signals, "b", ["2026-04-01", "2026-04-02"]);
  setRecallDays(signals, "c", ["2026-04-01", "2026-04-02"]);

  const result = await runRemPhase({ signals, phaseSignals, config: { ...baseConfig, llmDiary: false, diaryPath: join(dir, "diary.jsonl") }, logger });

  assertEqual(result.diary, undefined, "diary should be undefined");
  await rm(dir, { recursive: true, force: true });
});

// 6. LLM config + patterns > 0 → diary generated and appended to diaryPath
await test("LLM config + patterns > 0 → diary generated and appended", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  signals.recordRecall({ key: "a", layer: "free-text", snippet: "s1", queryHash: "h1", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  signals.recordRecall({ key: "b", layer: "free-text", snippet: "s2", queryHash: "h2", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  signals.recordRecall({ key: "c", layer: "free-text", snippet: "s3", queryHash: "h3", relevanceScore: 0.5, conceptTags: ["ts", "test"] });
  setRecallDays(signals, "a", ["2026-04-01", "2026-04-02"]);
  setRecallDays(signals, "b", ["2026-04-01", "2026-04-02"]);
  setRecallDays(signals, "c", ["2026-04-01", "2026-04-02"]);

  const diaryPath = join(dir, "diary.jsonl");
  const llm = new LLMConsolidator(
    { enabled: true, apiBase: "http://localhost:11434/v1", apiKey: "", model: "test", timeoutMs: 1000, maxBatchSize: 10 },
    logger,
  );
  // Override generateDiary to avoid actual network call
  (llm as LLMConsolidator & { generateDiary: (prompt: string) => Promise<string> }).generateDiary = async () => "Test diary entry.";

  const result = await runRemPhase({ signals, phaseSignals, config: { ...baseConfig, llmDiary: true, diaryPath }, llm, logger });

  assertEqual(result.diary, "Test diary entry.", "diary value");
  const diaryContent = await readFile(diaryPath, "utf-8");
  assert(diaryContent.includes("Test diary entry."), "diary should be appended to file");
  await rm(dir, { recursive: true, force: true });
});

// 7. empty signal store → 0 patterns, 0 boosts
await test("empty signal store → 0 patterns, 0 boosts", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  const result = await runRemPhase({ signals, phaseSignals, config: { ...baseConfig, diaryPath: join(dir, "diary.jsonl") }, logger });

  assertEqual(result.patternsDetected, 0, "patternsDetected");
  assertEqual(result.signalBoosts, 0, "signalBoosts");
  await rm(dir, { recursive: true, force: true });
});

// 8. 500 entries, 50 tags → completes < 200ms
await test("500 entries, 50 tags → completes < 200ms", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  for (let i = 0; i < 500; i++) {
    signals.recordRecall({
      key: `e${i}`,
      layer: "free-text",
      snippet: `snippet ${i}`,
      queryHash: `h${i}`,
      relevanceScore: 0.5,
      conceptTags: [`tag${i % 50}`],
    });
    setRecallDays(signals, `e${i}`, ["2026-04-01", "2026-04-02"]);
  }

  const start = performance.now();
  const result = await runRemPhase({ signals, phaseSignals, config: { ...baseConfig, diaryPath: join(dir, "diary.jsonl") }, logger });
  const elapsed = performance.now() - start;

  assertEqual(result.patternsDetected, 0, "patternsDetected (no pair co-occurs)");
  assertEqual(result.signalBoosts, 0, "signalBoosts");
  assert(elapsed < 200, `expected < 200ms, got ${elapsed.toFixed(2)}ms`);
  await rm(dir, { recursive: true, force: true });
});

// 9. >50 unique tags → only top 50 by entry count used
await test(">50 unique tags → only top 50 used", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  // Tags 0-49: 4 entries each (high count)
  for (let t = 0; t < 50; t++) {
    for (let i = 0; i < 4; i++) {
      signals.recordRecall({
        key: `e${t}_${i}`,
        layer: "free-text",
        snippet: "s",
        queryHash: `h${t}_${i}`,
        relevanceScore: 0.5,
        conceptTags: [`tag${t}`],
      });
      setRecallDays(signals, `e${t}_${i}`, ["2026-04-01", "2026-04-02"]);
    }
  }

  // Tag 50: only 3 entries, co-occurring with tag0
  for (let i = 0; i < 3; i++) {
    signals.recordRecall({
      key: `e50_${i}`,
      layer: "free-text",
      snippet: "s",
      queryHash: `h50_${i}`,
      relevanceScore: 0.5,
      conceptTags: ["tag50", "tag0"],
    });
    setRecallDays(signals, `e50_${i}`, ["2026-04-01", "2026-04-02"]);
  }

  const result = await runRemPhase({ signals, phaseSignals, config: { ...baseConfig, diaryPath: join(dir, "diary.jsonl") }, logger });

  // If tag50 were considered, (tag0, tag50) would form a pattern with 3 entries.
  // Since it is dropped (rank 51), no such pattern should exist.
  assertEqual(result.patternsDetected, 0, "patternsDetected (tag50 should be dropped)");
  await rm(dir, { recursive: true, force: true });
});

// 10. entry belongs to 3 patterns → remHit recorded only once
await test("entry in 3 patterns → remHit recorded once", async () => {
  const dir = await makeTempDir();
  const signals = new RecallSignalStore(join(dir, "signals.json"), baseConfig, logger);
  const phaseSignals = new PhaseSignalStore(join(dir, "phase.json"));

  // 3 entries all share tag1, tag2, tag3
  for (const key of ["a", "b", "c"]) {
    signals.recordRecall({
      key,
      layer: "free-text",
      snippet: `s${key}`,
      queryHash: `h${key}`,
      relevanceScore: 0.5,
      conceptTags: ["tag1", "tag2", "tag3"],
    });
    setRecallDays(signals, key, ["2026-04-01", "2026-04-02"]);
  }

  const result = await runRemPhase({ signals, phaseSignals, config: { ...baseConfig, diaryPath: join(dir, "diary.jsonl") }, logger });

  // Patterns: (1,2), (1,3), (2,3) — each with 3 entries
  assertEqual(result.patternsDetected, 3, "patternsDetected");
  // But each entry only boosted once
  assertEqual(result.signalBoosts, 3, "signalBoosts (3 unique entries)");
  assertEqual(phaseSignals.get("a")?.remHits, 1, "a remHits should be 1, not 3");
  await rm(dir, { recursive: true, force: true });
});

// Summary
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${passed}/${results.length} passed${failed > 0 ? `, ${failed} failed` : ""}`);
if (failed > 0) {
  process.exit(1);
}
