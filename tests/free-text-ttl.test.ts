// ============================================================================
// Tests: Free-text TTL (T1)
// Run with: npx tsx tests/free-text-ttl.test.ts
// ============================================================================

import { Mem0FreeTextBackend } from "../backends/free-text/mem0.js";
import { loadConfig } from "../types.js";
import type { MemuPluginConfig } from "../types.js";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEqual(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const logger = { info: (_: string) => {}, warn: (_: string) => {} };
const scope = { userId: "u1", agentId: "main", sessionKey: "s1" };

function makeConfig(overrides: Record<string, unknown> = {}): MemuPluginConfig {
  return loadConfig({ mem0: { mode: "open-source", ...overrides } });
}

type MockItem = { id?: string; memory?: string; score?: number; categories?: string[]; metadata?: Record<string, unknown>; created_at?: string; updated_at?: string };

function makeMockProvider(searchItems: MockItem[] = [], getAllItems: MockItem[] = []) {
  const capturedAddOpts: Record<string, unknown>[] = [];
  return {
    provider: {
      add: async (_msgs: unknown, opts: Record<string, unknown>) => {
        capturedAddOpts.push(opts);
        return { results: [{ id: "x" }] };
      },
      search: async () => searchItems,
      getAll: async () => getAllItems,
      delete: async () => {},
    } as any,
    capturedAddOpts,
  };
}

console.log("\nFree-text TTL Tests (T1)\n");

// Test 1: store() passes expires_at in metadata
await test("store() metadata includes expires_at when defaultTtlDays > 0", async () => {
  const { provider, capturedAddOpts } = makeMockProvider();
  const backend = new Mem0FreeTextBackend(makeConfig({ defaultTtlDays: 90 }), logger, async () => provider);
  await backend.store([{ role: "user", content: "hello" }], scope);
  assert(capturedAddOpts.length === 1, "add() was called");
  const metadata = capturedAddOpts[0].metadata as Record<string, unknown> | undefined;
  assert(typeof metadata?.expires_at === "number", "expires_at is a number");
  const expiresAt = metadata?.expires_at as number;
  assert(expiresAt > Date.now(), "expires_at is in the future");
  // Should be approximately 90 days from now (within 1 minute)
  const expected = Date.now() + 90 * 86_400_000;
  assert(Math.abs(expiresAt - expected) < 60_000, "expires_at ≈ now + 90 days");
});

// Test 2: search() filters out expired items
await test("search() excludes expired items by default", async () => {
  const pastTime = Date.now() - 1000;
  const futureTime = Date.now() + 86_400_000;
  const items: MockItem[] = [
    { id: "expired", memory: "old fact", score: 0.9, metadata: { expires_at: pastTime } },
    { id: "valid", memory: "new fact", score: 0.8, metadata: { expires_at: futureTime } },
    { id: "no-ttl", memory: "timeless fact", score: 0.7, metadata: {} },
  ];
  const backend = new Mem0FreeTextBackend(makeConfig(), logger, async () => makeMockProvider(items).provider);
  const results = await backend.search("fact", scope);
  const ids = results.map((r) => r.id);
  assert(!ids.includes("expired"), "expired item excluded");
  assert(ids.includes("valid"), "valid item included");
  assert(ids.includes("no-ttl"), "item without expires_at included");
});

// Test 3: list() filters out expired items
await test("list() excludes expired items by default", async () => {
  const pastTime = Date.now() - 1000;
  const futureTime = Date.now() + 86_400_000;
  const items: MockItem[] = [
    { id: "expired", memory: "old fact", metadata: { expires_at: pastTime } },
    { id: "valid1", memory: "new fact 1", metadata: { expires_at: futureTime } },
    { id: "valid2", memory: "new fact 2", metadata: {} },
  ];
  const backend = new Mem0FreeTextBackend(makeConfig(), logger, async () => makeMockProvider([], items).provider);
  const results = await backend.list(scope);
  assertEqual(results.length, 2, "2 valid items returned");
  assert(results.every((r) => r.id !== "expired"), "expired item not in list");
});

// Test 4: defaultTtlDays=0 → no expires_at
await test("defaultTtlDays=0 means no expires_at in metadata", async () => {
  const { provider, capturedAddOpts } = makeMockProvider();
  const backend = new Mem0FreeTextBackend(makeConfig({ defaultTtlDays: 0 }), logger, async () => provider);
  await backend.store([{ role: "user", content: "permanent fact" }], scope);
  assert(capturedAddOpts.length === 1, "add() was called");
  const metadata = capturedAddOpts[0].metadata as Record<string, unknown> | undefined;
  assert(!("expires_at" in (metadata ?? {})), "no expires_at when defaultTtlDays=0");
});

// Test 5: includeExpired=true returns expired items
await test("search({ includeExpired: true }) returns expired items", async () => {
  const pastTime = Date.now() - 1000;
  const items: MockItem[] = [
    { id: "expired", memory: "old fact", score: 0.9, metadata: { expires_at: pastTime } },
    { id: "valid", memory: "new fact", score: 0.8, metadata: {} },
  ];
  const backend = new Mem0FreeTextBackend(makeConfig(), logger, async () => makeMockProvider(items).provider);
  const results = await backend.search("fact", scope, { includeExpired: true });
  const ids = results.map((r) => r.id);
  assert(ids.includes("expired"), "expired item included when includeExpired=true");
  assert(ids.includes("valid"), "valid item included");
});

// Summary
console.log();
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
