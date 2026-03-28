// ============================================================================
// Tests: Persistent capture dedup store (T3)
// Run with: npx tsx tests/capture-dedup-persistent.test.ts
// ============================================================================

import { CaptureDedupStore } from "../capture-dedup-store.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

console.log("\nCaptureDedupStore Tests (T3)\n");

// Test 1: Hash persisted — survives across instances (simulated restart)
await test("same text's hash found in a new store instance after add", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-dedup-"));
  const store1 = new CaptureDedupStore(dir);
  const hash = CaptureDedupStore.hashText("我的编辑器是vim");
  await store1.add("scope1", hash);

  // Simulate restart: create new instance with same persistPath
  const store2 = new CaptureDedupStore(dir);
  const found = await store2.has("scope1", hash);
  assert(found, "hash recovered from disk in new instance");
});

// Test 2: Different hash → not deduplicated
await test("different text hash not found", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-dedup-"));
  const store = new CaptureDedupStore(dir);
  const hashA = CaptureDedupStore.hashText("text A");
  const hashB = CaptureDedupStore.hashText("text B");
  await store.add("scope1", hashA);
  const found = await store.has("scope1", hashB);
  assertEqual(found, false, "different hash not found");
});

// Test 3: Overflow evicts oldest hash
await test("oldest hash evicted when maxPerScope exceeded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-dedup-"));
  const store = new CaptureDedupStore(dir, 3); // maxPerScope=3
  const hashA = CaptureDedupStore.hashText("text A");
  const hashB = CaptureDedupStore.hashText("text B");
  const hashC = CaptureDedupStore.hashText("text C");
  const hashD = CaptureDedupStore.hashText("text D");

  await store.add("scope1", hashA);
  await store.add("scope1", hashB);
  await store.add("scope1", hashC);
  await store.add("scope1", hashD); // triggers eviction of hashA

  const aFound = await store.has("scope1", hashA);
  const dFound = await store.has("scope1", hashD);
  assertEqual(aFound, false, "oldest hash A evicted");
  assertEqual(dFound, true, "newest hash D present");
});

// Test 4: Different scopes are isolated
await test("hashes in different scopes do not interfere", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-dedup-"));
  const store = new CaptureDedupStore(dir);
  const hash = CaptureDedupStore.hashText("shared text");
  await store.add("scope1", hash);
  const found = await store.has("scope2", hash);
  assertEqual(found, false, "scope2 does not see scope1's hash");
});

// Test 5: Corrupted file → graceful degradation
await test("corrupted dedup file causes has() to return false (no throw)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-dedup-"));
  // Write invalid JSON directly
  await writeFile(join(dir, "capture-dedup.json"), "NOT JSON AT ALL", "utf-8");
  const store = new CaptureDedupStore(dir);
  let threw = false;
  let result = false;
  try {
    result = await store.has("scope1", "somehash");
  } catch {
    threw = true;
  }
  assert(!threw, "no exception thrown on corrupted file");
  assertEqual(result, false, "returns false on corruption");
});

// Summary
console.log();
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
