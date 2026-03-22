// ============================================================================
// Unit tests for ImportanceScorer
// Run with: npx tsx tests/consolidation-scorer.test.ts
// ============================================================================

import { ImportanceScorer } from "../consolidation/scorer.js";
import { DEFAULT_CONFIG } from "../types.js";
import type { CoreMemoryRecord } from "../types.js";

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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertApprox(actual: number, expected: number, tol: number, msg: string): void {
  if (Math.abs(actual - expected) > tol)
    throw new Error(`${msg}: got ${actual.toFixed(4)}, expected ~${expected.toFixed(4)} ±${tol}`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const SCOPE = { userId: "u", agentId: "a", sessionKey: "s" };

function makeRecord(
  overrides: Partial<CoreMemoryRecord> & Pick<CoreMemoryRecord, "id" | "key" | "value">,
): CoreMemoryRecord {
  return {
    category: "general",
    scope: SCOPE,
    createdAt: NOW - 7 * DAY,
    updatedAt: NOW - 7 * DAY,
    touchedAt: NOW - 7 * DAY,
    ...overrides,
  };
}

const scorer = new ImportanceScorer(DEFAULT_CONFIG.core.consolidation);

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("\nImportanceScorer Tests\n");

console.log("recency factor:");

test("fresh record has high recency (≥ 0.9)", () => {
  const r = makeRecord({ id: "1", key: "k", value: "v", touchedAt: NOW - 1 * DAY });
  const scored = scorer.scoreOne(r, [r]);
  assert(scored.factors.recency >= 0.9, `recency=${scored.factors.recency}`);
});

test("14-day-old record has recency ~0.37 (e^-1 for S=14)", () => {
  const r = makeRecord({ id: "2", key: "k", value: "v", touchedAt: NOW - 14 * DAY });
  const scored = scorer.scoreOne(r, [r]);
  assertApprox(scored.factors.recency, Math.exp(-1), 0.02, "14-day recency");
});

test("very old record (100d) has low recency", () => {
  const r = makeRecord({ id: "3", key: "k", value: "v", touchedAt: NOW - 100 * DAY });
  const scored = scorer.scoreOne(r, [r]);
  assert(scored.factors.recency < 0.1, `recency=${scored.factors.recency}`);
});

console.log("\nnovelyty factor:");

test("unique record in category has novelty = 1.0", () => {
  const r = makeRecord({ id: "4", key: "k", value: "I like Go", category: "technical" });
  const scored = scorer.scoreOne(r, [r]);
  assertApprox(scored.factors.novelty, 1.0, 0.001, "novelty solo");
});

test("duplicate record has low novelty", () => {
  const r1 = makeRecord({ id: "5", key: "k1", value: "User prefers dark mode themes", category: "preference" });
  const r2 = makeRecord({ id: "6", key: "k2", value: "User prefers dark mode themes", category: "preference" });
  const s1 = scorer.scoreOne(r1, [r1, r2]);
  assert(s1.factors.novelty < 0.2, `novelty for near-duplicate=${s1.factors.novelty}`);
});

test("distinct records in same category have high novelty", () => {
  const r1 = makeRecord({ id: "7", key: "lang", value: "User likes Go", category: "technical" });
  const r2 = makeRecord({ id: "8", key: "diet", value: "User is vegetarian", category: "technical" });
  const s1 = scorer.scoreOne(r1, [r1, r2]);
  assert(s1.factors.novelty > 0.7, `novelty distinct=${s1.factors.novelty}`);
});

console.log("\ntypePrior factor:");

test("profile tier → typePrior = 1.0", () => {
  const r = makeRecord({ id: "9", key: "k", value: "v", tier: "profile" });
  const scored = scorer.scoreOne(r, [r]);
  assertApprox(scored.factors.typePrior, 1.0, 0.001, "profile typePrior");
});

test("general tier → typePrior = 0.5", () => {
  const r = makeRecord({ id: "10", key: "k", value: "v", tier: "general" });
  const scored = scorer.scoreOne(r, [r]);
  assertApprox(scored.factors.typePrior, 0.5, 0.001, "general typePrior");
});

console.log("\nexplicitImportance factor:");

test("record with importance=1.0 → explicitImportance=1.0", () => {
  const r = makeRecord({ id: "11", key: "k", value: "v", importance: 1.0 });
  const scored = scorer.scoreOne(r, [r]);
  assertApprox(scored.factors.explicitImportance, 1.0, 0.001, "explicit importance");
});

test("record without importance → explicitImportance=0", () => {
  const r = makeRecord({ id: "12", key: "k", value: "v" });
  const scored = scorer.scoreOne(r, [r]);
  assertApprox(scored.factors.explicitImportance, 0, 0.001, "no explicit importance");
});

console.log("\ncomposite score:");

test("score is in [0, 1]", () => {
  const records = [
    makeRecord({ id: "13", key: "a", value: "alpha", tier: "profile", touchedAt: NOW - DAY }),
    makeRecord({ id: "14", key: "b", value: "beta", tier: "general", touchedAt: NOW - 50 * DAY }),
  ];
  const scored = scorer.scoreAll(records);
  for (const s of scored) {
    assert(s.score >= 0 && s.score <= 1, `score out of range: ${s.score}`);
  }
});

test("fresh high-importance record scores higher than old no-importance", () => {
  const fresh = makeRecord({ id: "15", key: "f", value: "important fact", tier: "profile", touchedAt: NOW, importance: 1.0 });
  const stale = makeRecord({ id: "16", key: "s", value: "stale fact", tier: "general", touchedAt: NOW - 90 * DAY });
  const [sf, ss] = scorer.scoreAll([fresh, stale]);
  assert(sf.score > ss.score, `fresh(${sf.score.toFixed(3)}) should > stale(${ss.score.toFixed(3)})`);
});

// ── Summary ──────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
