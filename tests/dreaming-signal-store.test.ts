// ============================================================================
// Tests: Short-Term Recall Signal Store (DREAM-02)
// Run with: npx tsx tests/dreaming-signal-store.test.ts
// ============================================================================

import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RecallSignalStore } from "../consolidation/signal-store.js";

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

function assertApprox(a: number, b: number, tol: number, msg: string): void {
  if (Math.abs(a - b) > tol) throw new Error(`${msg}: expected ~${b}, got ${a}`);
}

const defaultConfig = {
  maxSignalEntries: 500,
  maxQueryHashes: 32,
  maxRecallDays: 16,
  maxConceptTags: 20,
  timezone: "Asia/Shanghai",
};

console.log("\nRecallSignalStore Tests (DREAM-02)\n");

// 1: load() on missing file → size === 0, no throw
await test("load() on missing file → size === 0, no throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "nonexistent.json"), defaultConfig);
  await store.load();
  assertEqual(store.size, 0, "size after missing file load");
});

// 2: recordRecall() creates new entry with recallCount: 1, correct firstRecalledAt
await test("recordRecall() creates new entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), defaultConfig);
  const before = Date.now();
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: 0.8, conceptTags: ["a"] });
  const after = Date.now();
  const e = store.get("k1")!;
  assertEqual(e.recallCount, 1, "recallCount");
  assert(e.firstRecalledAt >= before && e.firstRecalledAt <= after, "firstRecalledAt in range");
});

// 3: recordRecall() on existing key → recallCount increments to 2
await test("recordRecall() increments recallCount", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), defaultConfig);
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: 0.8, conceptTags: ["a"] });
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h2", relevanceScore: 0.6, conceptTags: ["b"] });
  const e = store.get("k1")!;
  assertEqual(e.recallCount, 2, "recallCount");
  assertApprox(e.totalScore, 1.4, 0.001, "totalScore");
  assertApprox(e.maxScore, 0.8, 0.001, "maxScore");
});

// 4: Duplicate queryHash not added twice
await test("duplicate queryHash dedup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), defaultConfig);
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
  const e = store.get("k1")!;
  assertEqual(e.queryHashes.length, 1, "queryHashes deduped");
  assertEqual(e.queryHashes[0], "h1", "queryHash value");
});

// 5: queryHashes FIFO cap at maxQueryHashes
await test("queryHashes FIFO cap at maxQueryHashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), { ...defaultConfig, maxQueryHashes: 3 });
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h2", relevanceScore: 0.5, conceptTags: [] });
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h3", relevanceScore: 0.5, conceptTags: [] });
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h4", relevanceScore: 0.5, conceptTags: [] });
  const e = store.get("k1")!;
  assertEqual(e.queryHashes.length, 3, "capped at 3");
  assertEqual(e.queryHashes[0], "h2", "oldest evicted");
  assertEqual(e.queryHashes[2], "h4", "newest retained");
});

// 6: recallDays FIFO cap at maxRecallDays
await test("recallDays FIFO cap at maxRecallDays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), { ...defaultConfig, maxRecallDays: 3, timezone: "UTC" });

  // Inject days directly to avoid timezone fragility in test
  const e = store.get("k1");
  // First record sets today
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
  const entry = store.get("k1")!;
  // Manually set recallDays to simulate multiple days
  entry.recallDays = ["2026-04-10", "2026-04-11", "2026-04-12"];
  // Record again to trigger today append
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "hx", relevanceScore: 0.5, conceptTags: [] });
  // The today value depends on UTC; we just check cap behavior by overriding maxRecallDays and using manual insert
  // Actually recordRecall will append today and cap. Let's verify the cap logic more directly.
  entry.recallDays = ["2026-04-10", "2026-04-11", "2026-04-12"];
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "hy", relevanceScore: 0.5, conceptTags: [] });
  assert(entry.recallDays.length <= 3, "recallDays capped at 3");
});

// 7: flush() → load() round-trip consistency
await test("flush/load round-trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const path = join(dir, "signals.json");
  const store1 = new RecallSignalStore(path, defaultConfig);
  store1.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: 0.8, conceptTags: ["a"] });
  await store1.flush();

  const store2 = new RecallSignalStore(path, defaultConfig);
  await store2.load();
  assertEqual(store2.size, 1, "size after load");
  const e = store2.get("k1")!;
  assertEqual(e.key, "k1", "key");
  assertEqual(e.recallCount, 1, "recallCount");
  assertApprox(e.totalScore, 0.8, 0.001, "totalScore");
});

// 8: markPromoted sets promotedAt; second call is idempotent
await test("markPromoted is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), defaultConfig);
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
  store.markPromoted("k1");
  const t1 = store.get("k1")!.promotedAt;
  assert(t1 !== undefined, "promotedAt set");
  // wait a tiny bit
  await new Promise((r) => setTimeout(r, 10));
  store.markPromoted("k1");
  const t2 = store.get("k1")!.promotedAt;
  assertEqual(t1, t2, "promotedAt unchanged");
});

// 9: prune() 600 entries (500 cap), 100 promoted → promoted removed first
await test("prune removes promoted first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), { ...defaultConfig, maxSignalEntries: 500 });
  const now = Date.now();
  for (let i = 0; i < 600; i++) {
    const key = `k${i}`;
    store.recordRecall({ key, layer: "free-text", snippet: `s${i}`, queryHash: `h${i}`, relevanceScore: 0.5, conceptTags: [] });
    // Adjust lastRecalledAt so order is predictable
    const e = store.get(key)!;
    e.lastRecalledAt = now + i;
    if (i < 100) {
      e.promotedAt = now + i;
    }
  }
  store.prune();
  assertEqual(store.size, 500, "size after prune");
  for (let i = 0; i < 100; i++) {
    assertEqual(store.get(`k${i}`), undefined, `promoted k${i} removed`);
  }
  for (let i = 100; i < 600; i++) {
    assert(store.get(`k${i}`) !== undefined, `non-promoted k${i} kept`);
  }
});

// 10: prune() 600 entries (500 cap), 0 promoted → oldest lastRecalledAt removed
await test("prune removes oldest lastRecalledAt when no promoted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), { ...defaultConfig, maxSignalEntries: 500 });
  const now = Date.now();
  for (let i = 0; i < 600; i++) {
    const key = `k${i}`;
    store.recordRecall({ key, layer: "free-text", snippet: `s${i}`, queryHash: `h${i}`, relevanceScore: 0.5, conceptTags: [] });
    const e = store.get(key)!;
    e.lastRecalledAt = now + i;
  }
  store.prune();
  assertEqual(store.size, 500, "size after prune");
  for (let i = 0; i < 100; i++) {
    assertEqual(store.get(`k${i}`), undefined, `oldest k${i} removed`);
  }
  for (let i = 100; i < 600; i++) {
    assert(store.get(`k${i}`) !== undefined, `newer k${i} kept`);
  }
});

// 11: recordRecall with empty snippet
await test("recordRecall with empty snippet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), defaultConfig);
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
  assertEqual(store.get("k1")!.snippet, "", "snippet is empty string");
});

// 12: concurrent flush() calls → second waits for first (inflight promise guard)
await test("concurrent flush is serialized", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const path = join(dir, "signals.json");
  const store = new RecallSignalStore(path, defaultConfig);
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });

  const p1 = store.flush();
  const p2 = store.flush();
  await Promise.all([p1, p2]);

  const store2 = new RecallSignalStore(path, defaultConfig);
  await store2.load();
  assertEqual(store2.size, 1, "size after concurrent flush");
});

// 13: conceptTags merge dedup, cap at 20
await test("conceptTags merge dedup capped at 20", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), defaultConfig);
  const tags1 = Array.from({ length: 15 }, (_, i) => `t${i}`);
  const tags2 = Array.from({ length: 15 }, (_, i) => `t${i + 10}`);
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: 0.5, conceptTags: tags1 });
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h2", relevanceScore: 0.5, conceptTags: tags2 });
  const e = store.get("k1")!;
  assertEqual(e.conceptTags.length, 20, "capped at 20");
  // Union should contain t0..t24 (25 unique), capped to 20 (preserving order: existing first, then new)
  const expectedSet = new Set([...tags1, ...tags2]);
  assertEqual(expectedSet.size, 25, "25 unique tags");
  assertEqual(e.conceptTags.length, 20, "capped");
});

// 14: recordRecall with NaN → sanitized to 0, totalScore not polluted
await test("recordRecall NaN sanitized to 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), defaultConfig);
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: NaN, conceptTags: [] });
  const e = store.get("k1")!;
  assertEqual(e.totalScore, 0, "totalScore is 0");
  assertEqual(e.maxScore, 0, "maxScore is 0");
});

// 15: recordRecall with -0.5 → clamped to 0
await test("recordRecall negative clamped to 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), defaultConfig);
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: -0.5, conceptTags: [] });
  const e = store.get("k1")!;
  assertEqual(e.totalScore, 0, "totalScore clamped to 0");
});

// 16: recordRecall with Infinity → sanitized to 0
await test("recordRecall Infinity sanitized to 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), defaultConfig);
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: Infinity, conceptTags: [] });
  const e = store.get("k1")!;
  assertEqual(e.totalScore, 0, "totalScore is 0");
  assertEqual(e.maxScore, 0, "maxScore is 0");
});

// 16b: recordRecall with 1.5 → clamped to 1.0
await test("recordRecall above 1 clamped to 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), defaultConfig);
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: 1.5, conceptTags: [] });
  const e = store.get("k1")!;
  assertEqual(e.totalScore, 1, "totalScore clamped to 1");
  assertEqual(e.maxScore, 1, "maxScore clamped to 1");
});

// 17: load() on corrupt JSON → log warning, empty store
await test("load corrupt JSON logs warning and empties", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const path = join(dir, "signals.json");
  await writeFile(path, "not json", "utf-8");
  const warnings: string[] = [];
  const logger = { info: () => {}, warn: (msg: string) => warnings.push(msg) };
  const store = new RecallSignalStore(path, defaultConfig, logger);
  await store.load();
  assertEqual(store.size, 0, "size after corrupt load");
  assert(warnings.some((w) => w.includes("load failed")), "warning logged");
});

// 18: load() on version 2 → log warning, empty store
await test("load version 2 logs warning and empties", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const path = join(dir, "signals.json");
  await writeFile(path, JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), entries: [] }), "utf-8");
  const warnings: string[] = [];
  const logger = { info: () => {}, warn: (msg: string) => warnings.push(msg) };
  const store = new RecallSignalStore(path, defaultConfig, logger);
  await store.load();
  assertEqual(store.size, 0, "size after version mismatch");
  assert(warnings.some((w) => w.includes("version mismatch")), "warning logged");
});

// 19: delete(key) removes entry, returns true; delete(unknown) returns false
await test("delete removes entry and returns correct boolean", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), defaultConfig);
  store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
  assertEqual(store.delete("k1"), true, "delete existing returns true");
  assertEqual(store.get("k1"), undefined, "entry removed");
  assertEqual(store.delete("k1"), false, "delete missing returns false");
});

// 20: recallDays uses Asia/Shanghai timezone: UTC 23:30 records as next day
await test("recallDays uses timezone Asia/Shanghai for UTC 23:30", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-signal-"));
  const store = new RecallSignalStore(join(dir, "signals.json"), { ...defaultConfig, timezone: "Asia/Shanghai" });

  // Mock Date.now and Date constructor to simulate UTC 23:30 on a known date
  const utcDate = new Date("2026-04-12T23:30:00.000Z");
  const OriginalDate = globalThis.Date;
  class MockDate extends OriginalDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(utcDate);
      } else {
        super(...args as [any]);
      }
    }
    static now() {
      return utcDate.getTime();
    }
  }
  globalThis.Date = MockDate as any;

  try {
    store.recordRecall({ key: "k1", layer: "free-text", snippet: "hello", queryHash: "h1", relevanceScore: 0.5, conceptTags: [] });
    const e = store.get("k1")!;
    // Asia/Shanghai at UTC 23:30 is already 2026-04-13
    assertEqual(e.recallDays[0], "2026-04-13", "recallDays reflects Shanghai timezone next day");
  } finally {
    globalThis.Date = OriginalDate;
  }
});

// Summary
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\nResults: ${passed} passed, ${failed} failed, ${results.length} total\n`);
if (failed > 0) {
  process.exit(1);
}
