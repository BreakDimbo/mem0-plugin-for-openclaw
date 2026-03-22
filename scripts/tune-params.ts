// ============================================================================
// Parameter Tuning Analysis — run after 1+ weeks of real consolidation data
// Usage: npx tsx scripts/tune-params.ts
// ============================================================================

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { ImportanceScorer } from "../consolidation/scorer.js";
import { DEFAULT_CONFIG } from "../types.js";
import type { CoreMemoryRecord, ConsolidationConfig } from "../types.js";

const PERSIST_PATH = "~/.openclaw/data/memory-mem0";
const DEAD_LETTER = "~/.openclaw/data/memory-mem0/consolidation-dead-letter.jsonl";
const STATE_PATH = "~/.openclaw/data/memory-mem0/consolidation-state.json";

function resolve(p: string) { return p.replace(/^~/, homedir()); }

// ── Load data ─────────────────────────────────────────────────────────────────

const raw = await readFile(resolve(PERSIST_PATH) + "/core-memory.json", "utf-8");
const store = JSON.parse(raw) as { items: CoreMemoryRecord[] };
const records: CoreMemoryRecord[] = store.items.map((r) => ({
  ...r,
  importance: r.importance != null ? Math.min(1, r.importance / 10) : undefined,
}));

// Dead-letter: records deleted so far
let deadLetterRecords: Array<{ deletedAt: string; reason: string; record: CoreMemoryRecord }> = [];
try {
  const dlRaw = await readFile(resolve(DEAD_LETTER), "utf-8");
  deadLetterRecords = dlRaw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
} catch { /* no dead-letter yet */ }

// State: run history
let state: Record<string, unknown> = {};
try {
  state = JSON.parse(await readFile(resolve(STATE_PATH), "utf-8")) as Record<string, unknown>;
} catch { /* no state yet */ }

const scorer = new ImportanceScorer(DEFAULT_CONFIG.core.consolidation);
const scored = scorer.scoreAll(records);
const scores = scored.map((s) => s.score).sort((a, b) => a - b);

console.log(`\n${"═".repeat(60)}`);
console.log("Parameter Tuning Analysis");
console.log("═".repeat(60));

// ── 1. Score distribution histogram ──────────────────────────────────────────

console.log("\n📊 Score distribution histogram:");
const buckets = Array(10).fill(0);
for (const s of scores) buckets[Math.min(9, Math.floor(s * 10))]++;
for (let i = 0; i < 10; i++) {
  const lo = (i * 10).toString().padStart(2);
  const hi = ((i + 1) * 10).toString().padStart(3);
  const bar = "█".repeat(buckets[i]);
  console.log(`  ${lo}–${hi}%: ${bar.padEnd(20)} ${buckets[i]}`);
}

// Check for bimodality (healthy = high counts at both ends, low in middle)
const lowZone  = buckets.slice(0, 3).reduce((a, b) => a + b, 0);  // 0–30%
const midZone  = buckets.slice(3, 7).reduce((a, b) => a + b, 0);  // 30–70%
const highZone = buckets.slice(7).reduce((a, b) => a + b, 0);     // 70–100%
const bimodalScore = (lowZone + highZone) / scores.length;

console.log(`\n  Low zone  (0–30%):  ${lowZone} records`);
console.log(`  Mid zone  (30–70%): ${midZone} records  ← LLM boundary candidates`);
console.log(`  High zone (70–100%):${highZone} records`);
console.log(`  Bimodality score: ${(bimodalScore * 100).toFixed(0)}% in extremes ${bimodalScore > 0.7 ? "✅ healthy" : "⚠️  too many in middle — consider adjusting weights"}`);

// ── 2. Ebbinghaus decay check ─────────────────────────────────────────────────

console.log("\n⏱  Recency factor distribution:");
const recencyBuckets = Array(5).fill(0);
for (const s of scored) {
  recencyBuckets[Math.min(4, Math.floor(s.factors.recency * 5))]++;
}
const labels = ["0–20%", "20–40%", "40–60%", "60–80%", "80–100%"];
for (let i = 0; i < 5; i++) {
  console.log(`  recency ${labels[i]}: ${"█".repeat(recencyBuckets[i]).padEnd(15)} ${recencyBuckets[i]}`);
}

const now = Date.now();
const DAY = 86_400_000;
const maxAgeDays = Math.max(...records.map((r) => (now - (r.touchedAt ?? r.updatedAt ?? now)) / DAY));
const expectedRecencyAtMax = Math.exp(-maxAgeDays / DEFAULT_CONFIG.core.consolidation.decay.stabilityDays);

console.log(`\n  Oldest record: ${maxAgeDays.toFixed(1)}d`);
console.log(`  Expected recency at oldest: ${expectedRecencyAtMax.toFixed(3)} (S=${DEFAULT_CONFIG.core.consolidation.decay.stabilityDays}d)`);
if (expectedRecencyAtMax > 0.5) {
  console.log(`  ⚠️  All records still recency > 0.5 — system too young OR stabilityDays too large.`);
  const suggestedS = maxAgeDays / Math.log(2);  // S where oldest record hits recency=0.5
  console.log(`     Suggested stabilityDays to see deletions: ~${suggestedS.toFixed(0)}d (so oldest hits 0.5)`);
}

// ── 3. LLM boundary rate ──────────────────────────────────────────────────────

const t = DEFAULT_CONFIG.core.consolidation.thresholds;
const boundaryCount = scored.filter((s) => s.score >= t.llmLow && s.score <= t.llmHigh).length;
const boundaryRate = boundaryCount / scored.length;

console.log(`\n🤖 LLM boundary zone (${t.llmLow}–${t.llmHigh}):`);
console.log(`  ${boundaryCount}/${scored.length} records (${(boundaryRate * 100).toFixed(0)}%)`);
if (boundaryRate > 0.30) {
  console.log(`  ⚠️  Too many boundary candidates — consider narrowing llmLow/llmHigh or adjusting weights`);
} else if (boundaryRate < 0.05) {
  console.log(`  ℹ️  Very few boundary candidates — LLM underutilized, may widen range`);
} else {
  console.log(`  ✅ Boundary rate healthy`);
}

// ── 4. Dead-letter analysis ───────────────────────────────────────────────────

console.log(`\n🗑  Dead-letter log (${deadLetterRecords.length} records deleted so far):`);
if (deadLetterRecords.length === 0) {
  console.log("  None yet — system too young or thresholds too conservative.");
  // Estimate when first deletions would occur
  const stabilityDays = DEFAULT_CONFIG.core.consolidation.decay.stabilityDays;
  const deleteThreshold = t.delete;
  // Solve: e^(-t/S) * avg_other_factors < delete_threshold
  const avgOther = scored.reduce((sum, s) =>
    sum + (s.score - s.factors.recency * DEFAULT_CONFIG.core.consolidation.weights.recency), 0
  ) / scored.length;
  const maxRecency = deleteThreshold - avgOther;
  if (maxRecency > 0) {
    const daysToFirstDelete = -stabilityDays * Math.log(maxRecency / DEFAULT_CONFIG.core.consolidation.weights.recency);
    console.log(`  Estimated first deletions in ~${Math.max(0, daysToFirstDelete).toFixed(0)} days at current decay rate.`);
  }
} else {
  for (const entry of deadLetterRecords.slice(0, 5)) {
    console.log(`  - [${entry.record.category}/${entry.record.key}]: "${entry.record.value.slice(0, 50)}" — ${entry.reason}`);
  }
}

// ── 5. Factor correlation ─────────────────────────────────────────────────────

console.log("\n🔍 Factor variance (higher = more discriminating):");
const factorNames = ["recency", "accessFreq", "novelty", "typePrior", "explicitImportance"] as const;
for (const f of factorNames) {
  const vals = scored.map((s) => s.factors[f]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length;
  const std = Math.sqrt(variance);
  const bar = "█".repeat(Math.round(std * 20));
  console.log(`  ${f.padEnd(22)}: std=${std.toFixed(3)} ${bar}`);
}
console.log("  (Low std = factor isn't discriminating well — consider reducing its weight)");

// ── 6. Tuning recommendations ─────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log("Tuning Recommendations");
console.log("═".repeat(60));

const recommendations: string[] = [];

if (bimodalScore < 0.7) {
  recommendations.push("Weights: increase recency weight (→0.35) and decrease accessFreq (→0.15) to spread distribution");
}

if (boundaryRate > 0.30) {
  recommendations.push(`Thresholds: narrow LLM zone — try llmLow=${(t.llmLow + 0.05).toFixed(2)} llmHigh=${(t.llmHigh - 0.05).toFixed(2)}`);
}

if (expectedRecencyAtMax > 0.5 && maxAgeDays > 7) {
  const suggestedS = Math.round(maxAgeDays / Math.log(2));
  recommendations.push(`Decay: reduce stabilityDays from ${DEFAULT_CONFIG.core.consolidation.decay.stabilityDays} → ${suggestedS} to see first deletions`);
}

const accessFactorStd = Math.sqrt(
  scored.map((s) => s.factors.accessFreq).reduce((v, x, _, a) => {
    const m = a.reduce((s,n)=>s+n,0)/a.length; return v+(x-m)**2;
  }, 0) / scored.length
);
if (accessFactorStd < 0.1) {
  recommendations.push("accessFreq: factor has low variance (touchedAt proxy is weak) — consider reducing weight to 0.10 until real touch counts are tracked");
}

if (recommendations.length === 0) {
  console.log("\n✅ Parameters look healthy — no changes needed yet.");
} else {
  console.log("\nSuggested changes to openclaw.json core.consolidation:\n");
  for (const r of recommendations) {
    console.log(`  • ${r}`);
  }
}

console.log(`\nTotal runs so far: ${(state as { totalRuns?: number }).totalRuns ?? 0}`);
console.log(`Last daily:  ${(state as { lastDailyRun?: string }).lastDailyRun ?? "never"}`);
console.log(`Last weekly: ${(state as { lastWeeklyRun?: string }).lastWeeklyRun ?? "never"}`);
