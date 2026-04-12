// ============================================================================
// Unit Tests for Phase Signal Store (DREAM-05)
// Run with: npx tsx tests/dreaming-phase-signals.test.ts
// ============================================================================

import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PhaseSignalStore } from "../consolidation/phase-signal-store.js";

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

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function createStore(): Promise<{ store: PhaseSignalStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "phase-signals-"));
  const path = join(dir, "dreaming-phase-signals.json");
  return { store: new PhaseSignalStore(path), path };
}

console.log("\nPhase Signal Store Tests\n");

// 1. load() on missing file → size === 0
await test("load() on missing file initializes empty store", async () => {
  const { store } = await createStore();
  await store.load();
  assertEqual(store.size, 0, "size after missing file load");
});

// 2. recordLightHit("a") → get("a").lightHits === 1, lastLightAt set
await test("recordLightHit creates entry with lightHits 1 and lastLightAt", async () => {
  const { store } = await createStore();
  const before = Date.now();
  store.recordLightHit("a");
  const after = Date.now();
  const entry = store.get("a");
  assert(!!entry, "entry should exist");
  assertEqual(entry!.lightHits, 1, "lightHits");
  assert(entry!.lastLightAt !== undefined && entry!.lastLightAt >= before && entry!.lastLightAt <= after, "lastLightAt should be set to current time");
});

// 3. Two recordLightHit("a") → lightHits === 2
await test("recordLightHit accumulates lightHits", async () => {
  const { store } = await createStore();
  store.recordLightHit("a");
  store.recordLightHit("a");
  const entry = store.get("a");
  assertEqual(entry!.lightHits, 2, "lightHits after two hits");
});

// 4. recordRemHit("a") → get("a").remHits === 1
await test("recordRemHit creates entry with remHits 1", async () => {
  const { store } = await createStore();
  store.recordRemHit("a");
  const entry = store.get("a");
  assert(!!entry, "entry should exist");
  assertEqual(entry!.remHits, 1, "remHits");
});

// 5. light + rem independently accumulate on same entry
await test("light and rem hits accumulate independently on same entry", async () => {
  const { store } = await createStore();
  store.recordLightHit("a");
  store.recordLightHit("a");
  store.recordRemHit("a");
  store.recordRemHit("a");
  store.recordRemHit("a");
  const entry = store.get("a");
  assertEqual(entry!.lightHits, 2, "lightHits");
  assertEqual(entry!.remHits, 3, "remHits");
});

// 6. flush() → load() round-trip
await test("flush and load round-trip preserves data", async () => {
  const { store, path } = await createStore();
  store.recordLightHit("a");
  store.recordRemHit("a");
  await store.flush();

  const store2 = new PhaseSignalStore(path);
  await store2.load();
  assertEqual(store2.size, 1, "size after reload");
  const entry = store2.get("a");
  assert(!!entry, "entry should exist after reload");
  assertEqual(entry!.lightHits, 1, "lightHits after reload");
  assertEqual(entry!.remHits, 1, "remHits after reload");
  assert(typeof entry!.lastLightAt === "number", "lastLightAt should be number after reload");
  assert(typeof entry!.lastRemAt === "number", "lastRemAt should be number after reload");
});

// 7. prune(new Set(["a"])) removes "b" entry
await test("prune removes entries not in activeKeys", async () => {
  const { store } = await createStore();
  store.recordLightHit("a");
  store.recordLightHit("b");
  const removed = store.prune(new Set(["a"]));
  assertEqual(removed, 1, "removed count");
  assertEqual(store.size, 1, "size after prune");
  assert(!!store.get("a"), "a should remain");
  assertEqual(store.get("b"), undefined, "b should be removed");
});

// 8. get("unknown") → undefined
await test("get returns undefined for unknown key", async () => {
  const { store } = await createStore();
  assertEqual(store.get("unknown"), undefined, "unknown key");
});

// 9. prune(new Set()) removes all entries → size === 0
await test("prune with empty activeKeys removes all entries", async () => {
  const { store } = await createStore();
  store.recordLightHit("a");
  store.recordLightHit("b");
  const removed = store.prune(new Set());
  assertEqual(removed, 2, "removed count");
  assertEqual(store.size, 0, "size after prune all");
});

// 10. load() on corrupt JSON → log warning, empty store
await test("load() on corrupt JSON logs warning and initializes empty store", async () => {
  const { store, path } = await createStore();
  await writeFile(path, "not-json-at-all", "utf-8");
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);
  await store.load();
  console.warn = originalWarn;
  assertEqual(store.size, 0, "size after corrupt load");
  assert(warnings.some((w) => w.includes("phase-signal-store")), "should log a warning");
});

// -- Summary --
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
