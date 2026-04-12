// ============================================================================
// Unit Tests for Dream Scoring Engine (DREAM-04)
// Run with: npx tsx tests/dreaming-scorer.test.ts
// ============================================================================

import { DreamScorer } from "../consolidation/dream-scorer.js";
import type { ShortTermRecallEntry, PhaseSignalEntry } from "../consolidation/types.js";
import type { DreamingConfig } from "../types.js";

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

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function baseEntry(overrides?: Partial<ShortTermRecallEntry>): ShortTermRecallEntry {
  return {
    key: "test-key",
    layer: "free-text",
    snippet: "test snippet",
    recallCount: 0,
    totalScore: 0,
    maxScore: 0,
    firstRecalledAt: 0,
    lastRecalledAt: 0,
    queryHashes: [],
    recallDays: [],
    conceptTags: [],
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<DreamingConfig["scoring"]> & { normalizeWeights?: boolean }): DreamingConfig {
  return {
    enabled: true,
    schedule: { hourOfDay: 4 },
    signalStorePath: "",
    phaseSignalStorePath: "",
    diaryPath: "",
    scoring: {
      weights: {
        frequency: 0.24,
        relevance: 0.30,
        diversity: 0.15,
        recency: 0.15,
        consolidation: 0.10,
        conceptual: 0.06,
        ...(overrides?.weights ?? {}),
      },
      promotion: {
        minScore: 0.75,
        minRecallCount: 3,
        minUniqueQueries: 2,
        ...(overrides?.promotion ?? {}),
      },
    },
    maxSignalEntries: 500,
    maxQueryHashes: 32,
    maxRecallDays: 16,
    maxPromotionsPerCycle: 5,
    maxConceptTags: 20,
    dedupeThreshold: 0.85,
    llmDiary: false,
    timezone: "Asia/Shanghai",
    normalizeWeights: overrides?.normalizeWeights ?? false,
  };
}

console.log("\nDream Scorer Tests\n");

// 1. frequency signal
 test("frequency: recallCount=0 -> 0; 10 -> 1.0; 5 -> ~0.74", () => {
  const scorer = new DreamScorer(makeConfig());
  const now = Date.now();
  const r0 = scorer.score(baseEntry({ recallCount: 0, lastRecalledAt: now }), undefined, now);
  assertClose(r0.factors.frequency, 0, 1e-10, "frequency at 0");

  const r10 = scorer.score(baseEntry({ recallCount: 10, lastRecalledAt: now }), undefined, now);
  assertClose(r10.factors.frequency, 1.0, 1e-10, "frequency at 10");

  const r5 = scorer.score(baseEntry({ recallCount: 5, lastRecalledAt: now }), undefined, now);
  const expected5 = Math.min(1, Math.log1p(5) / Math.log1p(10));
  assertClose(r5.factors.frequency, expected5, 1e-10, "frequency at 5");
  assertClose(r5.factors.frequency, 0.7472217363092141, 1e-10, "frequency at 5 approx");
});

// 2. relevance signal
 test("relevance: totalScore=3.0, recallCount=3 -> 1.0; totalScore=0.5, recallCount=5 -> 0.1", () => {
  const scorer = new DreamScorer(makeConfig());
  const now = Date.now();
  const r1 = scorer.score(baseEntry({ totalScore: 3.0, recallCount: 3, lastRecalledAt: now }), undefined, now);
  assertClose(r1.factors.relevance, 1.0, 1e-10, "relevance max");

  const r2 = scorer.score(baseEntry({ totalScore: 0.5, recallCount: 5, lastRecalledAt: now }), undefined, now);
  assertClose(r2.factors.relevance, 0.1, 1e-10, "relevance low");
});

// 3. diversity signal
 test("diversity: 1 hash/1 day -> 0.2; 5 hash/3 day -> 1.0; 0 -> 0", () => {
  const scorer = new DreamScorer(makeConfig());
  const now = Date.now();
  const r1 = scorer.score(baseEntry({ queryHashes: ["a"], recallDays: ["2026-04-01"], lastRecalledAt: now }), undefined, now);
  assertClose(r1.factors.diversity, 0.2, 1e-10, "diversity low");

  const r2 = scorer.score(baseEntry({ queryHashes: ["a", "b", "c", "d", "e"], recallDays: ["2026-04-01", "2026-04-02", "2026-04-03"], lastRecalledAt: now }), undefined, now);
  assertClose(r2.factors.diversity, 1.0, 1e-10, "diversity max");

  const r3 = scorer.score(baseEntry({ queryHashes: [], recallDays: [], lastRecalledAt: now }), undefined, now);
  assertClose(r3.factors.diversity, 0, 1e-10, "diversity zero");
});

// 4. recency signal
 test("recency: now -> ~1.0; 14 days -> ~0.5; 28 days -> ~0.25", () => {
  const scorer = new DreamScorer(makeConfig());
  const now = Date.now();
  const r1 = scorer.score(baseEntry({ lastRecalledAt: now }), undefined, now);
  assertClose(r1.factors.recency, 1.0, 1e-10, "recency now");

  const r2 = scorer.score(baseEntry({ lastRecalledAt: now - 14 * 86400000 }), undefined, now);
  assertClose(r2.factors.recency, 0.5, 1e-10, "recency 14 days");

  const r3 = scorer.score(baseEntry({ lastRecalledAt: now - 28 * 86400000 }), undefined, now);
  assertClose(r3.factors.recency, 0.25, 1e-10, "recency 28 days");
});

// 5. consolidation sub-factor
 test("consolidation sub-factor: 30-day span -> ~0.69; single day -> 0", () => {
  const scorer = new DreamScorer(makeConfig());
  const now = Date.now();
  const days30 = ["2026-04-01", "2026-05-01"];
  const r1 = scorer.score(baseEntry({ recallDays: days30, lastRecalledAt: now }), undefined, now);
  const spacingRaw = Math.min(1, Math.log1p(1) / Math.log1p(4)); // ~0.4307
  const spanRaw = Math.min(1, 30 / 30); // 1.0
  const expected = Math.min(1, spacingRaw * 0.55 + spanRaw * 0.45);
  assertClose(r1.factors.consolidation, expected, 1e-10, "consolidation 30-day");
  assertClose(r1.factors.consolidation, 0.6868721069403663, 1e-10, "consolidation 30-day approx");

  const r2 = scorer.score(baseEntry({ recallDays: ["2026-04-01"], lastRecalledAt: now }), undefined, now);
  assertClose(r2.factors.consolidation, 0.2, 1e-10, "consolidation single day");
});

// 6. conceptual signal
 test("conceptual: 0 tags -> 0; 3 tags -> 0.5; 6+ tags -> 1.0", () => {
  const scorer = new DreamScorer(makeConfig());
  const now = Date.now();
  const r0 = scorer.score(baseEntry({ conceptTags: [], lastRecalledAt: now }), undefined, now);
  assertClose(r0.factors.conceptual, 0, 1e-10, "conceptual 0");

  const r3 = scorer.score(baseEntry({ conceptTags: ["a", "b", "c"], lastRecalledAt: now }), undefined, now);
  assertClose(r3.factors.conceptual, 0.5, 1e-10, "conceptual 3");

  const r6 = scorer.score(baseEntry({ conceptTags: ["a", "b", "c", "d", "e", "f"], lastRecalledAt: now }), undefined, now);
  assertClose(r6.factors.conceptual, 1.0, 1e-10, "conceptual 6");

  const r7 = scorer.score(baseEntry({ conceptTags: ["a", "b", "c", "d", "e", "f", "g"], lastRecalledAt: now }), undefined, now);
  assertClose(r7.factors.conceptual, 1.0, 1e-10, "conceptual 7 clamped");
});

// 7. phaseBoost signal
 test("phaseBoost: no signals -> 0; lightHits=3 -> ~0.05; remHits=2 -> ~0.08", () => {
  const scorer = new DreamScorer(makeConfig());
  const now = Date.now();
  const r0 = scorer.score(baseEntry({ lastRecalledAt: now }), undefined, now);
  assertClose(r0.factors.phaseBoost, 0, 1e-10, "phaseBoost none");

  const light: PhaseSignalEntry = { key: "k", lightHits: 3, remHits: 0, lastLightAt: now };
  const rLight = scorer.score(baseEntry({ lastRecalledAt: now }), light, now);
  assertClose(rLight.factors.phaseBoost, 0.05, 1e-10, "phaseBoost light");

  const rem: PhaseSignalEntry = { key: "k", lightHits: 0, remHits: 2, lastRemAt: now };
  const rRem = scorer.score(baseEntry({ lastRecalledAt: now }), rem, now);
  assertClose(rRem.factors.phaseBoost, 0.08, 1e-10, "phaseBoost rem");
});

// 8. weights sum to 1.0
 test("weights sum to 1.0 within 1e-10", () => {
  const scorer = new DreamScorer(makeConfig());
  const entry = baseEntry({ lastRecalledAt: Date.now() });
  const r = scorer.score(entry);
  // Access internal weights via score of a perfect entry
  const perfect = baseEntry({
    recallCount: 100,
    totalScore: 100,
    queryHashes: ["a", "b", "c", "d", "e"],
    recallDays: ["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04", "2026-04-05"],
    conceptTags: ["a", "b", "c", "d", "e", "f"],
    lastRecalledAt: Date.now(),
  });
  const rp = scorer.score(perfect);
  // With all factors at 1.0 and no phaseBoost, score should equal sum of weights
  const sum = rp.score - rp.factors.phaseBoost;
  assertClose(sum, 1.0, 1e-10, "weights sum");
});

// 9. all-zero entry -> score 0, factors all zero
 test("all-zero entry produces score 0 and all-zero factors", () => {
  const scorer = new DreamScorer(makeConfig());
  const entry = baseEntry();
  const r = scorer.score(entry);
  assertClose(r.score, 0, 1e-10, "score zero");
  assertClose(r.factors.frequency, 0, 1e-10, "factor frequency");
  assertClose(r.factors.relevance, 0, 1e-10, "factor relevance");
  assertClose(r.factors.diversity, 0, 1e-10, "factor diversity");
  assertClose(r.factors.recency, 0, 1e-10, "factor recency at epoch 0");
  assertClose(r.factors.consolidation, 0, 1e-10, "factor consolidation");
  assertClose(r.factors.conceptual, 0, 1e-10, "factor conceptual");
  assertClose(r.factors.phaseBoost, 0, 1e-10, "factor phaseBoost");
});

// 10. score clamped to [0, 1]
 test("score clamped to [0, 1] even with extreme values", () => {
  const config = makeConfig({ weights: { frequency: 2.0, relevance: 0, diversity: 0, recency: 0, consolidation: 0, conceptual: 0 } });
  const scorer = new DreamScorer(config);
  const entry = baseEntry({ recallCount: 100, lastRecalledAt: Date.now() });
  const r = scorer.score(entry);
  assertTrue(r.score <= 1.0 && r.score >= 0, `score should be clamped to [0,1], got ${r.score}`);
  assertClose(r.score, 1.0, 1e-10, "extreme score clamped to 1");
});

// 11. meetsPromotionThreshold eligible
 test("meetsPromotionThreshold: score=0.80, count=5, queries=3 -> eligible", () => {
  const scorer = new DreamScorer(makeConfig());
  const entry = baseEntry({ recallCount: 5, queryHashes: ["a", "b", "c"] });
  const result = scorer.meetsPromotionThreshold(entry, 0.80);
  assertTrue(result.eligible, "should be eligible");
  assertEqual(result.reasons.length, 0, "no reasons");
});

// 12. meetsPromotionThreshold ineligible due to recallCount
 test("meetsPromotionThreshold: score=0.80, count=2 -> ineligible with recallCount reason", () => {
  const scorer = new DreamScorer(makeConfig());
  const entry = baseEntry({ recallCount: 2, queryHashes: ["a", "b"] });
  const result = scorer.meetsPromotionThreshold(entry, 0.80);
  assertTrue(!result.eligible, "should be ineligible");
  assertTrue(result.reasons.some((r) => r.includes("recallCount")), "reason should mention recallCount");
});

// 13. meetsPromotionThreshold already promoted
 test("meetsPromotionThreshold: already promoted -> ineligible with already promoted reason", () => {
  const scorer = new DreamScorer(makeConfig());
  const entry = baseEntry({ recallCount: 5, queryHashes: ["a", "b", "c"], promotedAt: Date.now() });
  const result = scorer.meetsPromotionThreshold(entry, 0.80);
  assertTrue(!result.eligible, "should be ineligible");
  assertTrue(result.reasons.some((r) => r.includes("already promoted")), "reason should mention already promoted");
});

// 13b. meetsPromotionThreshold ineligible due to score < minScore
 test("meetsPromotionThreshold: score=0.70, count=5, queries=3 -> ineligible with score reason", () => {
  const scorer = new DreamScorer(makeConfig());
  const entry = baseEntry({ recallCount: 5, queryHashes: ["a", "b", "c"] });
  const result = scorer.meetsPromotionThreshold(entry, 0.70);
  assertTrue(!result.eligible, "should be ineligible");
  assertTrue(result.reasons.some((r) => r.includes("score")), "reason should mention score");
});

// 13c. meetsPromotionThreshold ineligible due to queryHashes < minUniqueQueries
 test("meetsPromotionThreshold: score=0.80, count=5, queries=1 -> ineligible with queries reason", () => {
  const scorer = new DreamScorer(makeConfig());
  const entry = baseEntry({ recallCount: 5, queryHashes: ["a"] });
  const result = scorer.meetsPromotionThreshold(entry, 0.80);
  assertTrue(!result.eligible, "should be ineligible");
  assertTrue(result.reasons.some((r) => r.includes("query") || r.includes("unique")), "reason should mention queries");
});

// 14. scoreBatch sorted by score DESC, ties by key ASC
 test("scoreBatch sorted by score DESC, ties by key ASC", () => {
  const scorer = new DreamScorer(makeConfig());
  const now = Date.now();
  const entries: ShortTermRecallEntry[] = [
    baseEntry({ key: "b", recallCount: 5, totalScore: 5, queryHashes: ["a"], lastRecalledAt: now }),
    baseEntry({ key: "a", recallCount: 5, totalScore: 5, queryHashes: ["a"], lastRecalledAt: now }),
    baseEntry({ key: "c", recallCount: 1, totalScore: 0.1, queryHashes: ["a"], lastRecalledAt: now }),
  ];
  const phaseSignals = new Map<string, PhaseSignalEntry>();
  const batch = scorer.scoreBatch(entries, phaseSignals, now);
  assertEqual(batch.length, 3, "batch length");
  assertEqual(batch[0].entry.key, "a", "first tie broken by key asc");
  assertEqual(batch[1].entry.key, "b", "second tie broken by key asc");
  assertEqual(batch[2].entry.key, "c", "lowest score last");
  assertTrue(batch[0].score >= batch[1].score, "score ordering");
});

// 15. frequency clamped at recallCount=20
 test("frequency clamped to 1.0 at recallCount=20", () => {
  const scorer = new DreamScorer(makeConfig());
  const now = Date.now();
  const r = scorer.score(baseEntry({ recallCount: 20, lastRecalledAt: now }), undefined, now);
  assertClose(r.factors.frequency, 1.0, 1e-10, "frequency clamped");
});

// 16. recency with future timestamp clamped
 test("recency: future lastRecalledAt clamps ageDays to 0 and recency=1.0", () => {
  const scorer = new DreamScorer(makeConfig());
  const now = Date.now();
  const r = scorer.score(baseEntry({ lastRecalledAt: now + 86400000 }), undefined, now);
  assertClose(r.factors.recency, 1.0, 1e-10, "recency future clamped");
});

// 17. relevance clamped
 test("relevance clamped to 1.0 when totalScore=5.0, recallCount=1", () => {
  const scorer = new DreamScorer(makeConfig());
  const now = Date.now();
  const r = scorer.score(baseEntry({ totalScore: 5.0, recallCount: 1, lastRecalledAt: now }), undefined, now);
  assertClose(r.factors.relevance, 1.0, 1e-10, "relevance clamped");
});

// 18. normalizeWeights: true with non-unity sum
 test("normalizeWeights: true normalizes weights and score is correct", () => {
  const rawWeights = { frequency: 0.5, relevance: 0.5, diversity: 0.5, recency: 0.5, consolidation: 0.5, conceptual: 0.5 };
  const config = makeConfig({ weights: rawWeights, normalizeWeights: true });
  const scorer = new DreamScorer(config);
  const now = Date.now();
  const entry = baseEntry({ recallCount: 10, totalScore: 10, queryHashes: ["a"], recallDays: ["2026-04-01"], conceptTags: ["x"], lastRecalledAt: now });
  const r = scorer.score(entry, undefined, now);
  // Normalized weights: each = 0.5/3 = 1/6
  // frequency=1, relevance=1, diversity=0.2, recency=1, consolidation=0.2, conceptual=1/6
  // Score = (1/6)*(1 + 1 + 0.2 + 1 + 0.2 + 1/6) = 0.5944...
  const expected = (1 / 6) * (1 + 1 + 0.2 + 1 + 0.2 + 1 / 6);
  assertClose(r.score, expected, 1e-10, "normalized score correct");
});

// -- Summary --
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
