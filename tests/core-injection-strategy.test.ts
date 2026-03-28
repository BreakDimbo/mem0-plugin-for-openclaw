// ============================================================================
// Tests: Core memory injection strategy (T4)
// Run with: npx tsx tests/core-injection-strategy.test.ts
// ============================================================================

import { inferTierFromCategory } from "../core-repository.js";

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

function assertEqual(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log("\nCore Injection Strategy Tests (T4)\n");

// Test 1: identity → profile tier (always-inject)
await test("identity category → profile tier", () => {
  assertEqual(inferTierFromCategory("identity"), "profile", "identity tier");
});

// Test 2: preferences → profile tier (always-inject)
await test("preferences category → profile tier", () => {
  assertEqual(inferTierFromCategory("preferences"), "profile", "preferences tier");
});

// Test 3: constraints → profile tier (T4 fix)
await test("constraints category → profile tier (T4 fix)", () => {
  assertEqual(inferTierFromCategory("constraints"), "profile", "constraints tier");
});

// Test 4: goals → profile tier
await test("goals category → profile tier", () => {
  assertEqual(inferTierFromCategory("goals"), "profile", "goals tier");
});

// Test 5: technical → technical tier (scoring-based, not always-inject)
await test("technical category → technical tier", () => {
  assertEqual(inferTierFromCategory("technical"), "technical", "technical tier");
});

// Test 6: architecture → technical tier
await test("architecture category → technical tier", () => {
  assertEqual(inferTierFromCategory("architecture"), "technical", "architecture tier");
});

// Test 7: unknown category → general tier
await test("unknown category → general tier (always-inject via default)", () => {
  assertEqual(inferTierFromCategory("project"), "general", "project tier");
  assertEqual(inferTierFromCategory("work"), "general", "work tier");
  assertEqual(inferTierFromCategory("unknown"), "general", "unknown tier");
});

// Test 8: relationships → profile tier
await test("relationships category → profile tier", () => {
  assertEqual(inferTierFromCategory("relationships"), "profile", "relationships tier");
});

// Summary
console.log();
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
