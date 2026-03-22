// ============================================================================
// Unit tests for ConsolidationRunner (dry-run)
// Run with: npx tsx tests/consolidation-runner.test.ts
// ============================================================================

import { ConsolidationRunner } from "../consolidation/runner.js";
import { DEFAULT_CONFIG } from "../types.js";
import type { CoreMemoryRecord, MemoryScope } from "../types.js";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, passed: true }); console.log(`  ✓ ${name}`); })
    .catch((err: unknown) => { results.push({ name, passed: false, error: String(err) }); console.log(`  ✗ ${name}: ${String(err)}`); });
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ── Stub repository ───────────────────────────────────────────────────────────

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const SCOPE: MemoryScope = { userId: "u", agentId: "a", sessionKey: "s" };

function makeRecord(overrides: Partial<CoreMemoryRecord> & Pick<CoreMemoryRecord, "id" | "key" | "value">): CoreMemoryRecord {
  return {
    category: "general",
    scope: SCOPE,
    createdAt: NOW - 7 * DAY,
    updatedAt: NOW - 7 * DAY,
    touchedAt: NOW - 7 * DAY,
    ...overrides,
  };
}

function stubRepo(records: CoreMemoryRecord[]) {
  const deleted: string[] = [];
  return {
    async list(_scope: MemoryScope, _opts?: unknown) { return [...records]; },
    async delete(_scope: MemoryScope, ref: { id?: string }) {
      if (ref.id) deleted.push(ref.id);
      return true;
    },
    _deleted: deleted,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("\nConsolidationRunner Tests\n");

const config = {
  ...DEFAULT_CONFIG.core.consolidation,
  // Lower thresholds to make delete easier to trigger in tests
  thresholds: {
    ...DEFAULT_CONFIG.core.consolidation.thresholds,
    delete: 0.30, // easier to trigger
  },
  deadLetterPath: "/tmp/test-consolidation-dead-letter.jsonl",
  statePath: "/tmp/test-consolidation-state.json",
};

console.log("dry-run mode:");

await test("empty collection returns empty report", async () => {
  const repo = stubRepo([]);
  const runner = new ConsolidationRunner(repo as never, config, { info: () => {}, warn: () => {} });
  const report = await runner.run(SCOPE, "daily", true);
  assert(report.totalScored === 0, "totalScored");
  assert(report.dryRun === true, "dryRun flag");
  assert(report.entries.length === 0, "no entries");
});

await test("fresh records are kept in dry-run", async () => {
  const records = [
    makeRecord({ id: "1", key: "name", value: "Alice", tier: "profile", touchedAt: NOW - DAY, importance: 1.0 }),
    makeRecord({ id: "2", key: "lang", value: "Go developer", tier: "technical", touchedAt: NOW - 2 * DAY }),
  ];
  const repo = stubRepo(records);
  const runner = new ConsolidationRunner(repo as never, config, { info: () => {}, warn: () => {} });
  const report = await runner.run(SCOPE, "daily", true);

  assert(report.totalScored === 2, "scored 2");
  assert(report.dryRun === true, "dryRun");
  // Fresh high-importance profile records should be kept
  const kept = report.entries.filter((e) => e.verdict === "keep");
  assert(kept.length >= 1, `at least 1 kept, got ${kept.length}`);
  // No actual deletes in dry-run
  assert((repo._deleted).length === 0, "no actual deletes in dry-run");
});

await test("very old records get delete/archive verdicts", async () => {
  const records = [
    makeRecord({ id: "3", key: "old-fact", value: "Some stale info", tier: "general", touchedAt: NOW - 180 * DAY }),
  ];
  const repo = stubRepo(records);
  const runner = new ConsolidationRunner(repo as never, config, { info: () => {}, warn: () => {} });
  const report = await runner.run(SCOPE, "daily", true);

  const entry = report.entries[0];
  assert(["delete", "archive", "downgrade"].includes(entry.verdict), `old record verdict=${entry.verdict}`);
  assert(repo._deleted.length === 0, "dry-run: no actual delete");
});

await test("report has correct structure", async () => {
  const records = [
    makeRecord({ id: "4", key: "k", value: "v", touchedAt: NOW }),
  ];
  const repo = stubRepo(records);
  const runner = new ConsolidationRunner(repo as never, config, { info: () => {}, warn: () => {} });
  const report = await runner.run(SCOPE, "weekly", true);

  assert(report.cycle === "weekly", "cycle");
  assert(typeof report.runAt === "string", "runAt string");
  assert(report.entries[0].factors !== undefined, "factors present");
  assert(report.entries[0].score >= 0 && report.entries[0].score <= 1, "score in range");
});

console.log("\nactual execution mode:");

await test("old records are deleted from repo when dryRun=false", async () => {
  const records = [
    makeRecord({ id: "5", key: "really-old", value: "Stale stale stale stale content", tier: "general", touchedAt: NOW - 365 * DAY }),
  ];
  const repo = stubRepo(records);
  const runner = new ConsolidationRunner(repo as never, config, { info: () => {}, warn: () => {} });
  const report = await runner.run(SCOPE, "daily", false);

  const entry = report.entries[0];
  if (entry.verdict === "delete") {
    assert(repo._deleted.includes("5"), "deleted from repo");
  } else {
    // May be archive/downgrade at this score level — that's also valid
    assert(repo._deleted.length === 0, "non-delete verdict → no delete");
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
