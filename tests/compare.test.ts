import { compareMemorySets } from "../backends/free-text/compare.js";
import { Metrics } from "../metrics.js";

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

function assertEqual(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log("\nCompare Helper Tests\n");

await test("compareMemorySets reports overlap and uniques", () => {
  const primary = [
    { id: "a", text: "tea", category: "general", source: "memu_item" as const, scope: { userId: "u", agentId: "a", sessionKey: "s" } },
    { id: "b", text: "coffee", category: "general", source: "memu_item" as const, scope: { userId: "u", agentId: "a", sessionKey: "s" } },
  ];
  const shadow = [
    { id: "a", text: "tea", category: "general", source: "memu_item" as const, scope: { userId: "u", agentId: "a", sessionKey: "s" } },
    { id: "c", text: "juice", category: "general", source: "memu_item" as const, scope: { userId: "u", agentId: "a", sessionKey: "s" } },
  ];
  const result = compareMemorySets(primary, shadow);
  assertEqual(result.primaryCount, 2, "primary count");
  assertEqual(result.shadowCount, 2, "shadow count");
  assertEqual(result.overlapCount, 1, "overlap count");
  assertEqual(result.primaryOnly.length, 1, "primary only count");
  assertEqual(result.shadowOnly.length, 1, "shadow only count");
  assertEqual(result.primaryOnly[0]?.text, "coffee", "primary only text");
  assertEqual(result.shadowOnly[0]?.text, "juice", "shadow only text");
});

await test("metrics snapshot includes fallback and compare counters", () => {
  const metrics = new Metrics();
  metrics.recordRecallFallback();
  metrics.recordRecallCompare(1, 2);
  metrics.recordRecallCompare(2, 2);

  const snap = metrics.snapshot({
    outbox: {
      sent: 0,
      failed: 0,
      pending: 0,
      deadLetterCount: 0,
      oldestPendingAgeMs: null,
      lastSentAt: null,
      lastFailedAt: null,
    },
    cache: { size: 0, hits: 0, misses: 0, hitRate: 0 },
    client: {
      totalRequests: 0,
      totalErrors: 0,
      circuitState: "closed",
      latencyStats: { p50: 0, p95: 0, p99: 0 },
    },
  });

  assertEqual(snap.recall.fallbackReads, 1, "fallback reads");
  assertEqual(snap.recall.compareRuns, 2, "compare runs");
  assertEqual(snap.recall.compareMismatches, 1, "compare mismatches");
});

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
