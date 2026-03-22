// Real data analysis script — run with: npx tsx scripts/real-data-analysis.ts
import { readFile } from "node:fs/promises";
import { ImportanceScorer } from "../consolidation/scorer.js";
import { ConsolidationRunner } from "../consolidation/runner.js";
import { CoreMemoryRepository } from "../core-repository.js";
import { DEFAULT_CONFIG } from "../types.js";
import type { CoreMemoryRecord, MemoryScope } from "../types.js";

const PERSIST_PATH = "~/.openclaw/data/memory-mem0";
// Primary agent scope (55 records)
const SCOPE: MemoryScope = { userId: "hao.break.zero", agentId: "turning_zero", sessionKey: "consolidation" };

// ── Load real data ────────────────────────────────────────────────────────────

const raw = await readFile(
  PERSIST_PATH.replace(/^~/, process.env.HOME ?? "~") + "/core-memory.json",
  "utf-8",
);
const store = JSON.parse(raw) as { items: CoreMemoryRecord[] };

// Normalize importance: stored as 0-10, scorer expects 0-1
const records: CoreMemoryRecord[] = store.items.map((r) => ({
  ...r,
  importance: r.importance != null ? Math.min(1, r.importance / 10) : undefined,
}));

console.log(`\n${"═".repeat(60)}`);
console.log(`Real Core Memory Analysis — ${records.length} records`);
console.log("═".repeat(60));

// ── Age distribution ──────────────────────────────────────────────────────────

const now = Date.now();
const DAY = 86_400_000;
const ages = records
  .map((r) => (now - (r.touchedAt ?? r.updatedAt ?? now)) / DAY)
  .sort((a, b) => a - b);

console.log("\nAge distribution (days since last touch):");
console.log(`  min:    ${ages[0].toFixed(1)}d`);
console.log(`  median: ${ages[Math.floor(ages.length / 2)].toFixed(1)}d`);
console.log(`  p75:    ${ages[Math.floor(ages.length * 0.75)].toFixed(1)}d`);
console.log(`  max:    ${ages[ages.length - 1].toFixed(1)}d`);

// ── Score all records ─────────────────────────────────────────────────────────

const scorer = new ImportanceScorer(DEFAULT_CONFIG.core.consolidation);
const scored = scorer.scoreAll(records);
scored.sort((a, b) => a.score - b.score);

console.log("\n🔻 LOWEST SCORING (most likely to consolidate):");
for (const s of scored.slice(0, 8)) {
  const age = ((now - (s.record.touchedAt ?? s.record.updatedAt ?? now)) / DAY).toFixed(1);
  console.log(
    `  score=${s.score.toFixed(3)} [recency=${s.factors.recency.toFixed(2)} novelty=${s.factors.novelty.toFixed(2)} type=${s.factors.typePrior.toFixed(2)}]` +
    ` age=${age}d — [${s.record.category}/${s.record.key}] ${s.record.value.slice(0, 55)}`,
  );
}

console.log("\n🔺 HIGHEST SCORING (most important to keep):");
for (const s of scored.slice(-8).reverse()) {
  const age = ((now - (s.record.touchedAt ?? s.record.updatedAt ?? now)) / DAY).toFixed(1);
  console.log(
    `  score=${s.score.toFixed(3)} [recency=${s.factors.recency.toFixed(2)} novelty=${s.factors.novelty.toFixed(2)} type=${s.factors.typePrior.toFixed(2)}]` +
    ` age=${age}d — [${s.record.category}/${s.record.key}] ${s.record.value.slice(0, 55)}`,
  );
}

// ── Verdict tally ─────────────────────────────────────────────────────────────

const t = DEFAULT_CONFIG.core.consolidation.thresholds;
const tally = { keep: 0, downgrade: 0, archive: 0, delete: 0, llmBoundary: 0 };

for (const s of scored) {
  if (s.score >= t.keep)           tally.keep++;
  else if (s.score >= t.downgrade) tally.downgrade++;
  else if (s.score >= t.archive)   tally.archive++;
  else                              tally.delete++;
  if (s.score >= t.llmLow && s.score <= t.llmHigh) tally.llmBoundary++;
}

console.log("\n📊 Verdict distribution (score-only, default thresholds):");
console.log(`  keep       (≥${t.keep}):  ${tally.keep} records`);
console.log(`  downgrade  (≥${t.downgrade}):  ${tally.downgrade} records`);
console.log(`  archive    (≥${t.archive}):  ${tally.archive} records`);
console.log(`  delete     (<${t.delete}):  ${tally.delete} records`);
console.log(`  llmBoundary (${t.llmLow}–${t.llmHigh}): ${tally.llmBoundary} records (would ask Qwen)`);

// ── Near-duplicate detection ──────────────────────────────────────────────────

console.log("\n🔁 Near-duplicate pairs (novelty < 0.25, same category):");
let dupCount = 0;
for (const s of scored) {
  if (s.factors.novelty < 0.25) {
    dupCount++;
    console.log(
      `  novelty=${s.factors.novelty.toFixed(3)} [${s.record.category}/${s.record.key}]: "${s.record.value.slice(0, 60)}"`,
    );
  }
}
if (dupCount === 0) console.log("  None detected.");

// ── Full dry-run via ConsolidationRunner ──────────────────────────────────────

console.log("\n" + "═".repeat(60));
console.log("DRY-RUN via ConsolidationRunner (real repository)");
console.log("═".repeat(60));

const repo = new CoreMemoryRepository(PERSIST_PATH, { info: console.log, warn: console.warn }, 300);
const consolidationConfig = {
  ...DEFAULT_CONFIG.core.consolidation,
  llm: {
    enabled: true,
    apiBase: "http://localhost:11434/v1",
    model: "qwen2.5:7b",
    timeoutMs: 30_000,
    maxBatchSize: 20,
  },
};
const runner = new ConsolidationRunner(repo, consolidationConfig, { info: console.log, warn: console.warn });

const report = await runner.run(SCOPE, "daily", true /* dry-run — LLM will be called for boundary records */);

console.log(`\nReport summary:`);
console.log(`  totalScored: ${report.totalScored}`);
console.log(`  keep:        ${report.kept}`);
console.log(`  downgrade:   ${report.downgraded}`);
console.log(`  archive:     ${report.archived}`);
console.log(`  delete:      ${report.deleted}`);
console.log(`  llmCalled:   ${report.llmCalled}`);
console.log(`  dryRun:      ${report.dryRun}`);

const deleteEntries = report.entries.filter((e) => e.verdict === "delete");
if (deleteEntries.length > 0) {
  console.log("\n🗑  Would delete:");
  for (const e of deleteEntries) {
    console.log(`  [${e.category}/${e.key ?? e.id}] score=${e.score.toFixed(3)} — ${e.snippet.slice(0, 60)}`);
    console.log(`    reason: ${e.reason}`);
  }
}

const archiveEntries = report.entries.filter((e) => e.verdict === "archive");
if (archiveEntries.length > 0) {
  console.log(`\n📦 Would archive (${archiveEntries.length}):`);
  for (const e of archiveEntries.slice(0, 5)) {
    console.log(`  [${e.category}/${e.key ?? e.id}] score=${e.score.toFixed(3)} — ${e.snippet.slice(0, 60)}`);
  }
}

const downgradeEntries = report.entries.filter((e) => e.verdict === "downgrade");
if (downgradeEntries.length > 0) {
  console.log(`\n⬇  Would downgrade (${downgradeEntries.length}):`);
  for (const e of downgradeEntries.slice(0, 5)) {
    console.log(`  [${e.category}/${e.key ?? e.id}] score=${e.score.toFixed(3)} — ${e.snippet.slice(0, 60)}`);
  }
}

console.log("\n✅ Dry-run complete — no changes written to disk.");
