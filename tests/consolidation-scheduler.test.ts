// ============================================================================
// Tests: consolidation/scheduler.ts — loadState / saveState / ConsolidationScheduler
// Run with: npx tsx tests/consolidation-scheduler.test.ts
// ============================================================================

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadState, saveState, ConsolidationScheduler } from "../consolidation/scheduler.js";
import type { ConsolidationState } from "../consolidation/scheduler.js";
import type { ConsolidationConfig, MemoryScope } from "../types.js";
import type { ConsolidationRunner } from "../consolidation/runner.js";
import type { ConsolidationReport } from "../consolidation/types.js";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpDir: string;

async function setup(): Promise<void> {
  tmpDir = await mkdtemp(join(tmpdir(), "scheduler-test-"));
}

async function teardown(): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true });
}

function makeStatePath(name: string): string {
  return join(tmpDir, name, "state.json");
}

const noop = { info: () => {}, warn: () => {} };

function makeConfig(overrides: Partial<ConsolidationConfig> = {}): ConsolidationConfig {
  // Only the fields accessed by ConsolidationScheduler are populated; the rest are cast.
  return {
    enabled: true,
    intervalMs: 3_600_000,
    statePath: makeStatePath("default"),
    schedule: {
      daily:   { enabled: true, hourOfDay: 2 },
      weekly:  { enabled: true, hourOfDay: 3, dayOfWeek: 0 },
      monthly: { enabled: true, hourOfDay: 4, dayOfMonth: 1 },
    },
    llm: { enabled: false, apiBase: "", apiKey: "", model: "", maxBatchSize: 10, timeoutMs: 30_000 },
    ...overrides,
  } as unknown as ConsolidationConfig;
}

const scope: MemoryScope = { userId: "test-user", agentId: "test-agent", sessionKey: "test-session" };

// ── loadState ─────────────────────────────────────────────────────────────────

console.log("\nConsolidation Scheduler Tests\n");

await setup();

await test("loadState: non-existent file → default { totalRuns: 0 }", async () => {
  const state = await loadState(makeStatePath("nonexistent"));
  assertEqual(state.totalRuns, 0, "totalRuns defaults to 0");
  assertEqual(state.lastDailyRun, undefined, "no lastDailyRun");
});

await test("loadState: valid JSON → parsed state", async () => {
  const path = makeStatePath("valid");
  const written: ConsolidationState = { totalRuns: 5, lastDailyRun: "2025-01-01T00:00:00.000Z" };
  await saveState(path, written);
  const loaded = await loadState(path);
  assertEqual(loaded.totalRuns, 5, "totalRuns preserved");
  assertEqual(loaded.lastDailyRun, "2025-01-01T00:00:00.000Z", "lastDailyRun preserved");
});

await test("loadState: invalid JSON → default state", async () => {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const path = makeStatePath("corrupt");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "not valid json", "utf-8");
  const state = await loadState(path);
  assertEqual(state.totalRuns, 0, "falls back to default on parse error");
});

// ── saveState ─────────────────────────────────────────────────────────────────

await test("saveState: round-trips full ConsolidationState", async () => {
  const path = makeStatePath("roundtrip");
  const state: ConsolidationState = {
    totalRuns: 12,
    lastDailyRun: "2025-03-01T02:00:00.000Z",
    lastWeeklyRun: "2025-02-28T03:00:00.000Z",
    lastMonthlyRun: "2025-03-01T04:00:00.000Z",
  };
  await saveState(path, state);
  const loaded = await loadState(path);
  assertEqual(loaded.totalRuns, 12, "totalRuns");
  assertEqual(loaded.lastDailyRun, "2025-03-01T02:00:00.000Z", "lastDailyRun");
  assertEqual(loaded.lastWeeklyRun, "2025-02-28T03:00:00.000Z", "lastWeeklyRun");
  assertEqual(loaded.lastMonthlyRun, "2025-03-01T04:00:00.000Z", "lastMonthlyRun");
});

await test("saveState: creates parent directories if missing", async () => {
  const path = join(tmpDir, "deep", "nested", "dirs", "state.json");
  await saveState(path, { totalRuns: 1 });
  const loaded = await loadState(path);
  assertEqual(loaded.totalRuns, 1, "state persisted through nested dirs");
});

// ── ConsolidationScheduler.forceRun ──────────────────────────────────────────

await test("forceRun: calls runner.run with correct cycle and dryRun=false", async () => {
  const calls: Array<{ scope: MemoryScope; cycle: string; dryRun: boolean }> = [];
  const mockRunner = {
    run: async (s: MemoryScope, cycle: string, dryRun: boolean): Promise<ConsolidationReport> => {
      calls.push({ scope: s, cycle, dryRun });
      return {
        cycle: cycle as "daily",
        runAt: new Date().toISOString(),
        dryRun,
        totalScored: 0,
        kept: 0,
        downgraded: 0,
        merged: 0,
        archived: 0,
        deleted: 0,
        llmCalled: false,
        entries: [],
      };
    },
  } as unknown as ConsolidationRunner;

  const config = makeConfig({ statePath: makeStatePath("forcerun") });
  const scheduler = new ConsolidationScheduler(mockRunner, config, scope, noop);
  await scheduler.forceRun("daily", false);

  assertEqual(calls.length, 1, "runner.run called once");
  assertEqual(calls[0].cycle, "daily", "correct cycle");
  assertEqual(calls[0].dryRun, false, "dryRun=false");
});

await test("forceRun with dryRun=true: runner called, state NOT persisted", async () => {
  const statePath = makeStatePath("dryrun");
  const mockRunner = {
    run: async (_s: MemoryScope, cycle: string, dryRun: boolean): Promise<ConsolidationReport> => ({
      cycle: cycle as "daily",
      runAt: new Date().toISOString(),
      dryRun,
      totalScored: 3,
      kept: 3,
      downgraded: 0,
      merged: 0,
      archived: 0,
      deleted: 0,
      llmCalled: false,
      entries: [],
    }),
  } as unknown as ConsolidationRunner;

  const config = makeConfig({ statePath });
  const scheduler = new ConsolidationScheduler(mockRunner, config, scope, noop);
  await scheduler.forceRun("daily", true);

  // dryRun=true should NOT save lastDailyRun
  const state = await loadState(statePath);
  assertEqual(state.lastDailyRun, undefined, "dryRun does not persist lastDailyRun");
});

await test("forceRun: inflight guard prevents duplicate concurrent runs", async () => {
  let runCount = 0;
  let resolveRun: () => void;
  const runPromise = new Promise<void>((r) => { resolveRun = r; });

  const mockRunner = {
    run: async (s: MemoryScope, cycle: string, dryRun: boolean): Promise<ConsolidationReport> => {
      runCount++;
      await runPromise;
      return {
        cycle: cycle as "daily", runAt: new Date().toISOString(), dryRun,
        totalScored: 0, kept: 0, downgraded: 0, merged: 0, archived: 0, deleted: 0, llmCalled: false, entries: [],
      };
    },
  } as unknown as ConsolidationRunner;

  const config = makeConfig({ statePath: makeStatePath("inflight") });
  const scheduler = new ConsolidationScheduler(mockRunner, config, scope, noop);

  // Start two concurrent forceRun calls for the same cycle
  const p1 = scheduler.forceRun("weekly", false);
  const p2 = scheduler.forceRun("weekly", false);

  resolveRun!();
  await Promise.all([p1, p2]);

  // Runner should only have been called once (second call deduped)
  assertEqual(runCount, 1, "runner called only once despite two concurrent forceRun calls");
});

await test("forceRun persists state after successful run", async () => {
  const statePath = makeStatePath("persist");
  const mockRunner = {
    run: async (_s: MemoryScope, cycle: string, dryRun: boolean): Promise<ConsolidationReport> => ({
      cycle: cycle as "monthly",
      runAt: new Date().toISOString(),
      dryRun,
      totalScored: 5,
      kept: 5,
      downgraded: 0,
      merged: 0,
      archived: 0,
      deleted: 0,
      llmCalled: false,
      entries: [],
    }),
  } as unknown as ConsolidationRunner;

  const config = makeConfig({ statePath });
  const scheduler = new ConsolidationScheduler(mockRunner, config, scope, noop);
  await scheduler.forceRun("monthly", false);

  const state = await loadState(statePath);
  assert(typeof state.lastMonthlyRun === "string", "lastMonthlyRun persisted");
  assertEqual(state.totalRuns, 1, "totalRuns incremented");
  assert(state.lastReport !== undefined, "lastReport saved");
  assertEqual(state.lastReport?.cycle, "monthly", "report cycle correct");
  assertEqual(state.lastReport?.totalScored, 5, "report totalScored correct");
});

// Cleanup
await teardown();

// Summary
console.log();
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
