// ============================================================================
// Unit Tests for LRU Cache
// Run with: npx tsx tests/cache.test.ts
// ============================================================================

import { LRUCache } from "../cache.js";

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

function assertEqual(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log("\nLRU Cache Tests\n");

test("set and get", () => {
  const cache = new LRUCache<string>(10, 60_000);
  cache.set("a", "value_a");
  assertEqual(cache.get("a"), "value_a", "get");
});

test("returns undefined for missing key", () => {
  const cache = new LRUCache<string>(10, 60_000);
  assertEqual(cache.get("missing"), undefined, "missing");
});

test("evicts oldest when full", () => {
  const cache = new LRUCache<string>(3, 60_000);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("c", "3");
  cache.set("d", "4"); // should evict oldest (at least "a" since 10% of 3 = 1)
  assertEqual(cache.get("a"), undefined, "evicted a");
  assertEqual(cache.get("d"), "4", "kept d");
});

test("LRU ordering: accessing moves to end", () => {
  const cache = new LRUCache<string>(3, 60_000);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("c", "3");
  cache.get("a"); // access "a", making "b" the oldest
  cache.set("d", "4"); // should evict "b" (oldest)
  assertEqual(cache.get("a"), "1", "a kept");
  assertEqual(cache.get("b"), undefined, "b evicted");
  assertEqual(cache.get("d"), "4", "d kept");
});

test("TTL expiration", () => {
  const cache = new LRUCache<string>(10, 1); // 1ms TTL
  cache.set("a", "1");
  // Wait for expiry
  const start = Date.now();
  while (Date.now() - start < 5) {} // busy wait 5ms
  assertEqual(cache.get("a"), undefined, "expired");
});

test("tracks hits and misses", () => {
  const cache = new LRUCache<string>(10, 60_000);
  cache.set("a", "1");
  cache.get("a"); // hit
  cache.get("b"); // miss
  cache.get("c"); // miss
  assertEqual(cache.hits, 1, "hits");
  assertEqual(cache.misses, 2, "misses");
  assert(cache.hitRate > 0.33 && cache.hitRate < 0.34, `hitRate should be ~0.33, got ${cache.hitRate}`);
});

test("clear resets everything", () => {
  const cache = new LRUCache<string>(10, 60_000);
  cache.set("a", "1");
  cache.get("a");
  cache.clear();
  assertEqual(cache.size, 0, "size");
  assertEqual(cache.hits, 0, "hits");
  assertEqual(cache.misses, 0, "misses");
});

test("hashKey produces consistent 16-char hex", () => {
  const h1 = LRUCache.hashKey("test input");
  const h2 = LRUCache.hashKey("test input");
  const h3 = LRUCache.hashKey("TEST INPUT"); // case-insensitive
  assertEqual(h1, h2, "deterministic");
  assertEqual(h1, h3, "case-insensitive");
  assertEqual(h1.length, 16, "length");
  assert(/^[a-f0-9]+$/.test(h1), "hex chars only");
});

test("has() checks existence without updating LRU", () => {
  const cache = new LRUCache<string>(10, 60_000);
  cache.set("a", "1");
  assert(cache.has("a"), "should have a");
  assert(!cache.has("b"), "should not have b");
});

test("buildCacheKey includes scope and limit", () => {
  const k1 = LRUCache.buildCacheKey("test", "scope1", 5);
  const k2 = LRUCache.buildCacheKey("test", "scope2", 5);
  const k3 = LRUCache.buildCacheKey("test", "scope1", 10);
  const k4 = LRUCache.buildCacheKey("test", "scope1", 5);
  assert(k1 !== k2, "different scope should differ");
  assert(k1 !== k3, "different limit should differ");
  assertEqual(k1, k4, "same inputs should match");
  assertEqual(k1.length, 16, "length");
});

// -- Summary --
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
