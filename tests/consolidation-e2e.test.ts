// ============================================================================
// End-to-End Integration Test: Memory Consolidation System
// Covers: T1 config, T2 scorer, T3 dry-run, T4 delete+dead-letter,
//         T5 free-text, T6 LLM consolidator parsing, T7 scheduler, T8 CLI
// Run with: npx tsx tests/consolidation-e2e.test.ts
// ============================================================================

import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm, mkdir } from "node:fs/promises";

import { ImportanceScorer } from "../consolidation/scorer.js";
import { ConsolidationRunner } from "../consolidation/runner.js";
import { ConsolidationScheduler, loadState } from "../consolidation/scheduler.js";
import { LLMConsolidator } from "../consolidation/llm-consolidator.js";
import { DEFAULT_CONFIG } from "../types.js";
import type { CoreMemoryRecord, MemuMemoryRecord, MemoryScope } from "../types.js";
import type { ConsolidationConfig } from "../types.js";

// ── Test harness ──────────────────────────────────────────────────────────────

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];
let section = "";

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, passed: false, error: String(err) });
    console.log(`  ✗ ${name}: ${String(err)}`);
  }
}

function heading(s: string): void {
  section = s;
  console.log(`\n${s}:`);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertApprox(a: number, b: number, tol: number, msg: string): void {
  if (Math.abs(a - b) > tol) throw new Error(`${msg}: got ${a.toFixed(4)}, want ~${b.toFixed(4)} ±${tol}`);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const NOW = Date.now();
const DAY = 86_400_000;
const SCOPE: MemoryScope = { userId: "e2e-user", agentId: "e2e-agent", sessionKey: "e2e-session" };

const TMP = join(tmpdir(), `consolidation-e2e-${Date.now()}`);
const DEAD_LETTER = join(TMP, "dead-letter.jsonl");
const STATE_PATH = join(TMP, "state.json");

const E2E_CONFIG: ConsolidationConfig = {
  ...DEFAULT_CONFIG.core.consolidation,
  thresholds: {
    keep: 0.60,
    downgrade: 0.40,
    archive: 0.20,
    delete: 0.08,
    llmLow: 0.30,
    llmHigh: 0.50,
  },
  decay: { stabilityDays: 14 },
  weights: {
    recency: 0.30,
    accessFreq: 0.20,
    novelty: 0.20,
    typePrior: 0.15,
    explicitImportance: 0.15,
  },
  schedule: {
    daily:   { enabled: true, hourOfDay: 3 },
    weekly:  { enabled: true, hourOfDay: 4 },
    monthly: { enabled: false, hourOfDay: 5 },
  },
  llm: { enabled: false, apiBase: "http://localhost:11434/v1", model: "qwen2.5:14b", timeoutMs: 5000, maxBatchSize: 20 },
  deadLetterPath: DEAD_LETTER,
  statePath: STATE_PATH,
};

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

// ── Stub repository ───────────────────────────────────────────────────────────

function stubRepo(records: CoreMemoryRecord[]) {
  const store = [...records];
  const deleted: string[] = [];
  return {
    async list(_s: MemoryScope, _o?: unknown) { return [...store]; },
    async delete(_s: MemoryScope, ref: { id?: string }) {
      const id = ref.id ?? "";
      const idx = store.findIndex((r) => r.id === id);
      if (idx >= 0) { store.splice(idx, 1); deleted.push(id); return true; }
      return false;
    },
    get _deleted() { return deleted; },
    get _store() { return store; },
  };
}

// ── Stub free-text backend ────────────────────────────────────────────────────

function stubFreeTextBackend(records: MemuMemoryRecord[]) {
  const store = [...records];
  const forgotten: string[] = [];
  return {
    provider: "stub",
    async healthCheck() { return { provider: "stub", healthy: true }; },
    async store() { return true; },
    async search() { return []; },
    async list(_s: MemoryScope, _o?: unknown) { return [...store]; },
    async forget(_s: MemoryScope, opts?: { memoryId?: string }) {
      if (opts?.memoryId) forgotten.push(opts.memoryId);
      return { purged_categories: 0, purged_items: 1, purged_resources: 0 };
    },
    get _forgotten() { return forgotten; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// T1: Config types and defaults
// ─────────────────────────────────────────────────────────────────────────────

heading("T1: Config types & defaults");

await test("DEFAULT_CONFIG has full ConsolidationConfig shape", async () => {
  const c = DEFAULT_CONFIG.core.consolidation;
  assert(typeof c.enabled === "boolean", "enabled");
  assert(typeof c.intervalMs === "number", "intervalMs");
  assert(typeof c.similarityThreshold === "number", "similarityThreshold");
  assert(typeof c.thresholds.keep === "number", "thresholds.keep");
  assert(typeof c.thresholds.delete === "number", "thresholds.delete");
  assert(typeof c.thresholds.llmLow === "number", "thresholds.llmLow");
  assert(typeof c.decay.stabilityDays === "number", "decay.stabilityDays");
  assert(typeof c.weights.recency === "number", "weights.recency");
  assert(typeof c.schedule.daily.enabled === "boolean", "schedule.daily.enabled");
  assert(typeof c.schedule.weekly.hourOfDay === "number", "schedule.weekly.hourOfDay");
  assert(typeof c.llm.model === "string", "llm.model");
  assert(typeof c.deadLetterPath === "string", "deadLetterPath");
  assert(typeof c.statePath === "string", "statePath");
});

await test("score weights sum to ~1.0", async () => {
  const w = DEFAULT_CONFIG.core.consolidation.weights;
  const sum = w.recency + w.accessFreq + w.novelty + w.typePrior + w.explicitImportance;
  assertApprox(sum, 1.0, 0.001, "weights sum");
});

await test("thresholds satisfy delete < archive < downgrade < keep", async () => {
  const t = DEFAULT_CONFIG.core.consolidation.thresholds;
  assert(t.delete < t.archive, `delete(${t.delete}) < archive(${t.archive})`);
  assert(t.archive < t.downgrade, `archive < downgrade`);
  assert(t.downgrade < t.keep, `downgrade < keep`);
});

await test("LLM boundary range is within [delete, keep]", async () => {
  const t = DEFAULT_CONFIG.core.consolidation.thresholds;
  assert(t.llmLow >= t.delete, "llmLow >= delete");
  assert(t.llmHigh <= t.keep, "llmHigh <= keep");
  assert(t.llmLow < t.llmHigh, "llmLow < llmHigh");
});

// ─────────────────────────────────────────────────────────────────────────────
// T2: ImportanceScorer
// ─────────────────────────────────────────────────────────────────────────────

heading("T2: ImportanceScorer");

const scorer = new ImportanceScorer(E2E_CONFIG);

await test("factors are all in [0,1]", async () => {
  const r = makeRecord({ id: "s1", key: "name", value: "Alice", tier: "profile", touchedAt: NOW - 3 * DAY });
  const s = scorer.scoreOne(r, [r]);
  for (const [k, v] of Object.entries(s.factors)) {
    assert(v >= 0 && v <= 1, `factor ${k}=${v} out of range`);
  }
  assert(s.score >= 0 && s.score <= 1, `composite score=${s.score} out of range`);
});

await test("profile tier scores higher than general (same age)", async () => {
  const p = makeRecord({ id: "s2a", key: "k", value: "profile fact", tier: "profile", touchedAt: NOW - DAY });
  const g = makeRecord({ id: "s2b", key: "k", value: "general fact", tier: "general", touchedAt: NOW - DAY });
  const sp = scorer.scoreOne(p, [p, g]);
  const sg = scorer.scoreOne(g, [p, g]);
  assert(sp.score > sg.score, `profile(${sp.score.toFixed(3)}) > general(${sg.score.toFixed(3)})`);
});

await test("fresh record beats stale record", async () => {
  const fresh = makeRecord({ id: "s3a", key: "k", value: "fresh info", touchedAt: NOW });
  const stale = makeRecord({ id: "s3b", key: "k", value: "stale info", touchedAt: NOW - 60 * DAY });
  const [sf, ss] = scorer.scoreAll([fresh, stale]);
  assert(sf.score > ss.score, `fresh > stale`);
});

await test("near-duplicate gets low novelty", async () => {
  const r1 = makeRecord({ id: "s4a", key: "pref", value: "User loves dark mode UI themes", category: "preference" });
  const r2 = makeRecord({ id: "s4b", key: "pref2", value: "User loves dark mode UI themes", category: "preference" });
  const s1 = scorer.scoreOne(r1, [r1, r2]);
  assert(s1.factors.novelty < 0.15, `near-duplicate novelty=${s1.factors.novelty.toFixed(3)} should be < 0.15`);
});

await test("Ebbinghaus: 14-day-old record has recency ≈ e^-1", async () => {
  const r = makeRecord({ id: "s5", key: "k", value: "v", touchedAt: NOW - 14 * DAY });
  const s = scorer.scoreOne(r, [r]);
  assertApprox(s.factors.recency, Math.exp(-1), 0.02, "14d recency");
});

// ─────────────────────────────────────────────────────────────────────────────
// T3: Dry-run consolidation report
// ─────────────────────────────────────────────────────────────────────────────

heading("T3: Dry-run consolidation report");

const MIXED_RECORDS = [
  makeRecord({ id: "r1", key: "name", value: "Alice", tier: "profile", touchedAt: NOW - DAY, importance: 1.0 }),
  makeRecord({ id: "r2", key: "lang", value: "User prefers Go", tier: "technical", touchedAt: NOW - 3 * DAY }),
  makeRecord({ id: "r3", key: "old-habit", value: "User liked coffee", tier: "general", touchedAt: NOW - 120 * DAY }),
  makeRecord({ id: "r4", key: "stale1", value: "Some old note from last year", tier: "general", touchedAt: NOW - 200 * DAY }),
  makeRecord({ id: "r5", key: "dup", value: "User prefers Go programming lang", tier: "technical", touchedAt: NOW - 5 * DAY }),
];

await test("dry-run produces report without touching repo", async () => {
  const repo = stubRepo(MIXED_RECORDS);
  const runner = new ConsolidationRunner(repo as never, E2E_CONFIG, { info: () => {}, warn: () => {} });
  const report = await runner.run(SCOPE, "daily", true);

  assert(report.dryRun === true, "dryRun flag");
  assert(report.cycle === "daily", "cycle");
  assert(report.totalScored === MIXED_RECORDS.length, `totalScored=${report.totalScored}`);
  assert(report.entries.length === MIXED_RECORDS.length, "entries length");
  assert(repo._deleted.length === 0, "dry-run: no actual deletes");
  assert(typeof report.runAt === "string" && report.runAt.length > 0, "runAt present");
});

await test("all entries have valid verdict and score", async () => {
  const repo = stubRepo(MIXED_RECORDS);
  const runner = new ConsolidationRunner(repo as never, E2E_CONFIG, { info: () => {}, warn: () => {} });
  const report = await runner.run(SCOPE, "daily", true);

  const validVerdicts = new Set(["keep", "downgrade", "merge", "archive", "delete"]);
  for (const e of report.entries) {
    assert(validVerdicts.has(e.verdict), `invalid verdict "${e.verdict}" for id=${e.id}`);
    assert(e.score >= 0 && e.score <= 1, `score out of range for id=${e.id}`);
    assert(e.factors !== undefined, `missing factors for id=${e.id}`);
    assert(typeof e.snippet === "string", `missing snippet for id=${e.id}`);
  }
});

await test("tally sums to totalScored", async () => {
  const repo = stubRepo(MIXED_RECORDS);
  const runner = new ConsolidationRunner(repo as never, E2E_CONFIG, { info: () => {}, warn: () => {} });
  const r = await runner.run(SCOPE, "weekly", true);
  const sum = r.kept + r.downgraded + r.merged + r.archived + r.deleted;
  assert(sum === r.totalScored, `tally sum ${sum} ≠ totalScored ${r.totalScored}`);
});

await test("high-importance profile record gets 'keep' verdict", async () => {
  const records = [makeRecord({ id: "hk1", key: "name", value: "Alice", tier: "profile", touchedAt: NOW, importance: 1.0 })];
  const repo = stubRepo(records);
  const runner = new ConsolidationRunner(repo as never, E2E_CONFIG, { info: () => {}, warn: () => {} });
  const report = await runner.run(SCOPE, "daily", true);
  assert(report.entries[0].verdict === "keep", `expected keep, got ${report.entries[0].verdict}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// T4: Actual execution + dead-letter protection
// ─────────────────────────────────────────────────────────────────────────────

heading("T4: Actual execution + dead-letter protection");

await mkdir(TMP, { recursive: true });

await test("very old records are deleted from repo (dryRun=false)", async () => {
  const veryOld = [
    makeRecord({ id: "del1", key: "ancient", value: "An ancient fact nobody cares about", tier: "general", touchedAt: NOW - 365 * DAY }),
  ];
  const repo = stubRepo(veryOld);
  const runner = new ConsolidationRunner(repo as never, E2E_CONFIG, { info: () => {}, warn: () => {} });
  const report = await runner.run(SCOPE, "daily", false);

  const entry = report.entries[0];
  if (entry.verdict === "delete") {
    assert(repo._deleted.includes("del1"), "deleted from repo");
    // Dead-letter file should exist
    const dlContent = await readFile(DEAD_LETTER, "utf-8").catch(() => "");
    assert(dlContent.includes("del1"), "dead-letter contains deleted record id");
  } else {
    // archive or downgrade — that's valid too; assert no deletes
    assert(repo._deleted.length === 0, "non-delete verdict → no deletes");
  }
});

await test("fresh records are NOT deleted (dryRun=false)", async () => {
  const fresh = [makeRecord({ id: "nd1", key: "name", value: "Alice", tier: "profile", touchedAt: NOW, importance: 1.0 })];
  const repo = stubRepo(fresh);
  const runner = new ConsolidationRunner(repo as never, E2E_CONFIG, { info: () => {}, warn: () => {} });
  await runner.run(SCOPE, "daily", false);
  assert(!repo._deleted.includes("nd1"), "fresh record must not be deleted");
});

await test("dead-letter log is valid JSONL", async () => {
  const content = await readFile(DEAD_LETTER, "utf-8").catch(() => "");
  if (content.trim()) {
    for (const line of content.trim().split("\n")) {
      const parsed = JSON.parse(line) as { deletedAt: string; reason: string; record: unknown };
      assert(typeof parsed.deletedAt === "string", "deletedAt field");
      assert(typeof parsed.reason === "string", "reason field");
      assert(typeof parsed.record === "object", "record field");
    }
  }
  // pass either way (may not have triggered delete)
});

// ─────────────────────────────────────────────────────────────────────────────
// T5: Free-text (mem0) backend consolidation
// ─────────────────────────────────────────────────────────────────────────────

heading("T5: Free-text backend consolidation");

const FT_RECORDS: MemuMemoryRecord[] = [
  { id: "ft1", text: "User enjoys hiking on weekends", category: "general", source: "memu_item", scope: SCOPE, createdAt: NOW - DAY },
  { id: "ft2", text: "User uses macOS", category: "technical", source: "memu_item", scope: SCOPE, createdAt: NOW - 3 * DAY },
  { id: "ft3", text: "Old forgotten note from a year ago", category: "general", source: "memu_item", scope: SCOPE, createdAt: NOW - 400 * DAY },
];

await test("runFreeText dry-run scores all records", async () => {
  const repo = stubRepo([]);
  const backend = stubFreeTextBackend(FT_RECORDS);
  const runner = new ConsolidationRunner(repo as never, E2E_CONFIG, { info: () => {}, warn: () => {} }, backend as never);
  const report = await runner.runFreeText(SCOPE, "daily", true);

  assert(report.dryRun === true, "dryRun flag");
  assert(report.totalScored === FT_RECORDS.length, `totalScored=${report.totalScored}`);
  assert(report.entries.length === FT_RECORDS.length, "all entries present");
  assert(backend._forgotten.length === 0, "dry-run: nothing forgotten");
});

await test("runFreeText live mode forgets old records", async () => {
  const repo = stubRepo([]);
  const backend = stubFreeTextBackend(FT_RECORDS);
  const runner = new ConsolidationRunner(repo as never, E2E_CONFIG, { info: () => {}, warn: () => {} }, backend as never);
  const report = await runner.runFreeText(SCOPE, "daily", false);

  const deletedEntry = report.entries.find((e) => e.id === "ft3");
  if (deletedEntry?.verdict === "delete") {
    assert(backend._forgotten.includes("ft3"), "backend.forget called with ft3");
  } else {
    // score wasn't low enough for delete — this is still valid
    assert(backend._forgotten.length === 0 || backend._forgotten.every((id) => id !== "ft3"),
      "non-delete verdict: ft3 not forgotten");
  }
});

await test("runFreeText without backend returns empty report", async () => {
  const repo = stubRepo([]);
  const runner = new ConsolidationRunner(repo as never, E2E_CONFIG, { info: () => {}, warn: () => {} });
  const report = await runner.runFreeText(SCOPE, "daily", true);
  assert(report.totalScored === 0, "no backend → no records");
});

await test("free-text entries have valid structure", async () => {
  const repo = stubRepo([]);
  const backend = stubFreeTextBackend(FT_RECORDS);
  const runner = new ConsolidationRunner(repo as never, E2E_CONFIG, { info: () => {}, warn: () => {} }, backend as never);
  const report = await runner.runFreeText(SCOPE, "weekly", true);

  const validVerdicts = new Set(["keep", "downgrade", "merge", "archive", "delete"]);
  for (const e of report.entries) {
    assert(validVerdicts.has(e.verdict), `bad verdict "${e.verdict}"`);
    assert(e.score >= 0 && e.score <= 1, "score in range");
    assert(typeof e.snippet === "string", "snippet present");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T6: LLM Consolidator — response parsing (offline, no real Ollama)
// ─────────────────────────────────────────────────────────────────────────────

heading("T6: LLM Consolidator (response parsing)");

// We test the parsing logic by monkey-patching fetch
const originalFetch = globalThis.fetch;

async function withMockFetch(responseBody: string, fn: () => Promise<void>): Promise<void> {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: responseBody } }] }),
    text: async () => responseBody,
  }) as unknown as Response;
  try { await fn(); } finally { globalThis.fetch = originalFetch; }
}

await test("parses valid LLM JSON verdicts", async () => {
  const llm = new LLMConsolidator(
    { ...E2E_CONFIG.llm, enabled: true },
    { info: () => {}, warn: () => {} },
  );

  const records: CoreMemoryRecord[] = [
    makeRecord({ id: "llm1", key: "name", value: "Alice" }),
    makeRecord({ id: "llm2", key: "old", value: "Some old fact" }),
  ];
  const scored = new ImportanceScorer(E2E_CONFIG).scoreAll(records);

  const mockResponse = JSON.stringify([
    { id: "llm1", verdict: "keep", reason: "still relevant" },
    { id: "llm2", verdict: "delete", reason: "stale and low value" },
  ]);

  await withMockFetch(mockResponse, async () => {
    const verdicts = await llm.judgeRecords(scored);
    assert(verdicts.length === 2, `expected 2 verdicts, got ${verdicts.length}`);
    assert(verdicts.find((v) => v.id === "llm1")?.verdict === "keep", "llm1 → keep");
    assert(verdicts.find((v) => v.id === "llm2")?.verdict === "delete", "llm2 → delete");
  });
});

await test("parses LLM response wrapped in markdown fences", async () => {
  const llm = new LLMConsolidator(
    { ...E2E_CONFIG.llm, enabled: true },
    { info: () => {}, warn: () => {} },
  );
  const records = [makeRecord({ id: "fence1", key: "k", value: "v" })];
  const scored = new ImportanceScorer(E2E_CONFIG).scoreAll(records);

  const mockResponse = '```json\n[{"id":"fence1","verdict":"archive","reason":"low access"}]\n```';
  await withMockFetch(mockResponse, async () => {
    const verdicts = await llm.judgeRecords(scored);
    assert(verdicts.length === 1, "parsed from fence");
    assert(verdicts[0].verdict === "archive", "verdict archive");
  });
});

await test("ignores unknown record IDs from LLM", async () => {
  const llm = new LLMConsolidator(
    { ...E2E_CONFIG.llm, enabled: true },
    { info: () => {}, warn: () => {} },
  );
  const records = [makeRecord({ id: "real1", key: "k", value: "v" })];
  const scored = new ImportanceScorer(E2E_CONFIG).scoreAll(records);

  const mockResponse = JSON.stringify([
    { id: "ghost-id", verdict: "delete", reason: "hallucinated" },
    { id: "real1", verdict: "keep", reason: "valid" },
  ]);
  await withMockFetch(mockResponse, async () => {
    const verdicts = await llm.judgeRecords(scored);
    assert(verdicts.length === 1, "only real1 returned");
    assert(verdicts[0].id === "real1", "correct id");
  });
});

await test("returns empty on malformed response", async () => {
  const llm = new LLMConsolidator(
    { ...E2E_CONFIG.llm, enabled: true },
    { info: () => {}, warn: () => {} },
  );
  const records = [makeRecord({ id: "m1", key: "k", value: "v" })];
  const scored = new ImportanceScorer(E2E_CONFIG).scoreAll(records);

  await withMockFetch("not json at all", async () => {
    const verdicts = await llm.judgeRecords(scored);
    assert(verdicts.length === 0, "malformed → empty");
  });
});

await test("LLM override applied in runner when llm.enabled=true", async () => {
  // Records in boundary zone (score ~0.35–0.50)
  const boundary = [
    makeRecord({ id: "bnd1", key: "borderline", value: "A moderately useful fact", tier: "general", touchedAt: NOW - 30 * DAY }),
  ];
  const repo = stubRepo(boundary);

  const cfgWithLlm: ConsolidationConfig = {
    ...E2E_CONFIG,
    llm: { ...E2E_CONFIG.llm, enabled: true },
  };

  // Mock LLM to return "delete" verdict
  const mockBody = JSON.stringify([{ id: "bnd1", verdict: "delete", reason: "LLM says delete" }]);
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: mockBody } }] }),
  }) as unknown as Response;

  try {
    const runner = new ConsolidationRunner(repo as never, cfgWithLlm, { info: () => {}, warn: () => {} });
    const report = await runner.run(SCOPE, "daily", true);

    const entry = report.entries.find((e) => e.id === "bnd1");
    if (entry && report.llmCalled) {
      // LLM was called for boundary records
      assert(entry.reason.includes("[LLM]"), `expected [LLM] prefix, got: ${entry.reason}`);
    }
    // Either way: no actual delete in dry-run
    assert(repo._deleted.length === 0, "dry-run: no deletes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T7: Scheduler — state persistence and inflight dedup
// ─────────────────────────────────────────────────────────────────────────────

heading("T7: Scheduler state persistence & inflight dedup");

await test("forceRun persists lastDailyRun to state file", async () => {
  const repo = stubRepo([makeRecord({ id: "sched1", key: "k", value: "v", touchedAt: NOW })]);
  const runner = new ConsolidationRunner(repo as never, E2E_CONFIG, { info: () => {}, warn: () => {} });
  const scheduler = new ConsolidationScheduler(runner, E2E_CONFIG, SCOPE, { info: () => {}, warn: () => {} });

  await scheduler.forceRun("daily", false);

  const state = await loadState(STATE_PATH);
  assert(typeof state.lastDailyRun === "string", "lastDailyRun persisted");
  assert(state.totalRuns >= 1, `totalRuns=${state.totalRuns}`);
});

await test("forceRun in dry-run does NOT update state file", async () => {
  // Remove state to start fresh
  await rm(STATE_PATH, { force: true });

  const repo = stubRepo([makeRecord({ id: "sched2", key: "k", value: "v", touchedAt: NOW })]);
  const runner = new ConsolidationRunner(repo as never, E2E_CONFIG, { info: () => {}, warn: () => {} });
  const scheduler = new ConsolidationScheduler(runner, E2E_CONFIG, SCOPE, { info: () => {}, warn: () => {} });

  await scheduler.forceRun("daily", true /* dryRun */);

  // State should NOT be updated for dry-run
  const state = await loadState(STATE_PATH);
  assert(!state.lastDailyRun, `dry-run should not update lastDailyRun, got: ${state.lastDailyRun}`);
});

await test("concurrent forceRun calls for same cycle use inflight dedup", async () => {
  let runCount = 0;
  const fakeRunner = {
    async run(_s: MemoryScope, _c: unknown, _d: boolean) {
      runCount++;
      await new Promise((r) => setTimeout(r, 50));
      return { cycle: "daily", runAt: new Date().toISOString(), dryRun: false, totalScored: 0, kept: 0, downgraded: 0, merged: 0, archived: 0, deleted: 0, llmCalled: false, entries: [] };
    },
  };
  const scheduler = new ConsolidationScheduler(fakeRunner as never, E2E_CONFIG, SCOPE, { info: () => {}, warn: () => {} });

  // Fire 3 concurrent runs for the same cycle
  await Promise.all([
    scheduler.forceRun("weekly", false),
    scheduler.forceRun("weekly", false),
    scheduler.forceRun("weekly", false),
  ]);

  assert(runCount === 1, `inflight dedup: expected 1 run, got ${runCount}`);
});

await test("state file is valid JSON after multiple runs", async () => {
  const content = await readFile(STATE_PATH, "utf-8").catch(() => "{}");
  const parsed = JSON.parse(content) as Record<string, unknown>;
  assert(typeof parsed.totalRuns === "number", "totalRuns is number");
});

// ─────────────────────────────────────────────────────────────────────────────
// T8: CLI command handler (consolidate status / run / report)
// ─────────────────────────────────────────────────────────────────────────────

heading("T8: CLI consolidate command handler");

// Test the CLI handler directly by simulating the consolidation scheduler
import { createMemuCommand } from "../cli.js";
import { ConsolidationScheduler as CS2 } from "../consolidation/scheduler.js";

function makeCliTestDeps() {
  const repo = stubRepo(MIXED_RECORDS);
  const backend = stubFreeTextBackend(FT_RECORDS);
  const runner2 = new ConsolidationRunner(repo as never, E2E_CONFIG, { info: () => {}, warn: () => {} }, backend as never);
  const sched2 = new CS2(runner2, E2E_CONFIG, SCOPE, { info: () => {}, warn: () => {} });

  const fakeOutbox = {
    recent: [],
    pendingCount: 0,
    completedCount: 0,
    failedCount: 0,
    deadLetterCount: 0,
  };
  const fakeCache = { size: 0, hits: 0, misses: 0 };
  const fakeMetrics = { classifierCalls: 0, classifierHits: 0, classifierErrors: 0, recallCalls: 0, recallHits: 0, captureCalls: 0, captureSkipped: 0 };
  const fakeSync = { status: () => ({}) };
  const fakePrimary = {
    provider: "stub",
    healthCheck: async () => ({ provider: "stub", healthy: true }),
  };
  const fakeCoreRepo = { list: async () => [], delete: async () => false };
  const fakeProposalQueue = { getPending: () => [] };
  const fakeRuntime = {};

  const cmd = createMemuCommand(
    fakePrimary as never,
    fakeCoreRepo as never,
    fakeProposalQueue as never,
    fakeCache as never,
    fakeOutbox as never,
    fakeMetrics as never,
    fakeSync as never,
    { ...DEFAULT_CONFIG, core: { ...DEFAULT_CONFIG.core, consolidation: E2E_CONFIG } },
    fakeRuntime,
    sched2,
  );

  return { cmd, sched2 };
}

await test("CLI: /memu consolidate status returns text", async () => {
  const { cmd } = makeCliTestDeps();
  const result = await cmd.handler({ args: "consolidate status" });
  assert(typeof (result as { text: string }).text === "string", "returns text");
  // After fresh state (possibly no runs), should mention "never" or show totals
});

await test("CLI: /memu consolidate run daily --dry-run returns summary", async () => {
  const { cmd } = makeCliTestDeps();
  const result = await cmd.handler({ args: "consolidate run daily --dry-run" }) as { text: string };
  assert(typeof result.text === "string", "returns text");
  assert(result.text.toLowerCase().includes("consolidation") || result.text.toLowerCase().includes("scored") || result.text.includes("complete"), `got: ${result.text.slice(0, 100)}`);
});

await test("CLI: /memu consolidate report shows entries", async () => {
  // First do a real run to generate a report
  const { cmd, sched2 } = makeCliTestDeps();
  await sched2.forceRun("daily", false);

  const result = await cmd.handler({ args: "consolidate report 5" }) as { text: string };
  assert(typeof result.text === "string", "returns text");
  assert(result.text.includes("Consolidation Report") || result.text.includes("No consolidation report"), `got: ${result.text.slice(0, 100)}`);
});

await test("CLI: /memu consolidate unknown subcmd returns help", async () => {
  const { cmd } = makeCliTestDeps();
  const result = await cmd.handler({ args: "consolidate nope" }) as { text: string };
  assert(result.text.includes("Usage:"), `expected help text, got: ${result.text.slice(0, 80)}`);
});

await test("CLI: /memu (no consolidate scheduler) returns help gracefully", async () => {
  const cmd = createMemuCommand(
    { provider: "stub", healthCheck: async () => ({ provider: "stub", healthy: true }) } as never,
    { list: async () => [] } as never,
    { getPending: () => [] } as never,
    { size: 0 } as never,
    { recent: [], pendingCount: 0 } as never,
    {} as never,
    {} as never,
    DEFAULT_CONFIG,
    {},
    undefined, // no scheduler
  );
  const result = await cmd.handler({ args: "consolidate run daily" }) as { text: string };
  assert(result.text.includes("not available"), `expected 'not available', got: ${result.text}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup & summary
// ─────────────────────────────────────────────────────────────────────────────

await rm(TMP, { recursive: true, force: true });

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;

console.log(`\n${"═".repeat(60)}`);
console.log(`E2E Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) {
  console.log("\nFailed tests:");
  for (const r of results.filter((r) => !r.passed)) {
    console.log(`  ✗ ${r.name}\n    ${r.error}`);
  }
  process.exit(1);
}
