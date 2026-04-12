// ============================================================================
// Unit Tests for Dreaming Types and Configuration (DREAM-01)
// Run with: npx tsx tests/dreaming-types.test.ts
// ============================================================================

import { DEFAULT_CONFIG, loadConfig } from "../types.js";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, passed: false, error: String(err) });
    console.log(`  ✗ ${name}: ${String(err)}`);
  }
}

function assertEqual(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertClose(a: number, b: number, epsilon: number, msg: string): void {
  if (Math.abs(a - b) > epsilon) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

console.log("\nDreaming Types Tests\n");

// 1. DEFAULT_CONFIG.dreaming.enabled === false
 test("DEFAULT_CONFIG.dreaming.enabled is false", () => {
  assertEqual(DEFAULT_CONFIG.dreaming.enabled, false, "enabled default");
});

// 2. DEFAULT_CONFIG.dreaming.scoring.weights sum === 1.0
 test("DEFAULT_CONFIG.dreaming.scoring.weights sum to 1.0", () => {
  const w = DEFAULT_CONFIG.dreaming.scoring.weights;
  const sum = w.frequency + w.relevance + w.diversity + w.recency + w.consolidation + w.conceptual;
  assertClose(sum, 1.0, 1e-10, "weights sum");
});

// 3. Partial override retains other defaults
 test("partial override of dreaming preserves other defaults", () => {
  const cfg = loadConfig({ dreaming: { enabled: true, schedule: { hourOfDay: 5 } } });
  assertEqual(cfg.dreaming.enabled, true, "enabled overridden");
  assertEqual(cfg.dreaming.schedule.hourOfDay, 5, "hourOfDay overridden");
  assertEqual(cfg.dreaming.maxSignalEntries, 500, "maxSignalEntries default preserved");
  assertEqual(cfg.dreaming.scoring.promotion.minScore, 0.75, "promotion default preserved");
});

// 4. Deep merge for scoring.weights
 test("deep merge for scoring.weights preserves other weights", () => {
  const cfg = loadConfig({ dreaming: { scoring: { weights: { frequency: 0.5 } }, normalizeWeights: false } });
  assertEqual(cfg.dreaming.scoring.weights.frequency, 0.5, "frequency overridden");
  assertEqual(cfg.dreaming.scoring.weights.relevance, 0.30, "relevance default preserved");
  assertEqual(cfg.dreaming.scoring.weights.diversity, 0.15, "diversity default preserved");
  assertEqual(cfg.dreaming.scoring.weights.recency, 0.15, "recency default preserved");
  assertEqual(cfg.dreaming.scoring.weights.consolidation, 0.10, "consolidation default preserved");
  assertEqual(cfg.dreaming.scoring.weights.conceptual, 0.06, "conceptual default preserved");
});

// 5. maxSignalEntries clamped [50, 5000]
 test("maxSignalEntries clamped to [50, 5000]", () => {
  const cfgLow = loadConfig({ dreaming: { maxSignalEntries: 10 } });
  assertEqual(cfgLow.dreaming.maxSignalEntries, 50, "low clamp");
  const cfgHigh = loadConfig({ dreaming: { maxSignalEntries: 10000 } });
  assertEqual(cfgHigh.dreaming.maxSignalEntries, 5000, "high clamp");
});

// 6. maxPromotionsPerCycle: 0 clamped to 1
 test("maxPromotionsPerCycle clamped to minimum 1", () => {
  const cfg = loadConfig({ dreaming: { maxPromotionsPerCycle: 0 } });
  assertEqual(cfg.dreaming.maxPromotionsPerCycle, 1, "zero clamped to 1");
});

// 7. Runtime path resolution for empty signalStorePath
 test("runtime path resolution when signalStorePath is empty", () => {
  const cfg = loadConfig({});
  const expected = `${cfg.dataDir}/dreaming-signals.json`;
  assertEqual(cfg.dreaming.signalStorePath, expected, "signalStorePath resolved");
  const expectedPhase = `${cfg.dataDir}/dreaming-phase-signals.json`;
  assertEqual(cfg.dreaming.phaseSignalStorePath, expectedPhase, "phaseSignalStorePath resolved");
  const expectedDiary = `${cfg.dataDir}/dream-diary.jsonl`;
  assertEqual(cfg.dreaming.diaryPath, expectedDiary, "diaryPath resolved");
});

// 8. normalizeWeights: true auto-normalizes; false keeps raw
 test("normalizeWeights auto-normalizes when true and keeps raw when false", () => {
  // true (default)
  const cfgNorm = loadConfig({ dreaming: { scoring: { weights: { frequency: 0.5 } } } });
  const wNorm = cfgNorm.dreaming.scoring.weights;
  const sumNorm = wNorm.frequency + wNorm.relevance + wNorm.diversity + wNorm.recency + wNorm.consolidation + wNorm.conceptual;
  assertClose(sumNorm, 1.0, 1e-10, "normalized sum");

  // false
  const cfgRaw = loadConfig({ dreaming: { scoring: { weights: { frequency: 0.5 } }, normalizeWeights: false } });
  const wRaw = cfgRaw.dreaming.scoring.weights;
  assertEqual(wRaw.frequency, 0.5, "raw frequency");
  const sumRaw = wRaw.frequency + wRaw.relevance + wRaw.diversity + wRaw.recency + wRaw.consolidation + wRaw.conceptual;
  assertClose(sumRaw, 1.26, 1e-10, "raw sum unchanged");
});

// 9. timezone default Asia/Shanghai used for recallDays generation
 test("timezone default is Asia/Shanghai and affects date generation", () => {
  const cfg = loadConfig({});
  assertEqual(cfg.dreaming.timezone, "Asia/Shanghai", "timezone default");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: cfg.dreaming.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dateStr = formatter.format(new Date("2026-04-12T23:30:00.000Z"));
  assertEqual(dateStr, "2026-04-13", "UTC 23:30 maps to next day in Shanghai");
});

// -- Summary --
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
