import { benchmarkBackends, benchmarkSearchProfiles, formatBenchmarkReport, formatSearchBenchmarkReport, summarizeSearchBenchmark } from "../backends/free-text/benchmark.js";
import type { FreeTextBackend } from "../backends/free-text/base.js";
import type { MemoryScope } from "../types.js";

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

const scope: MemoryScope = {
  userId: "alice",
  agentId: "researcher",
  sessionKey: "agent:researcher:main",
};

function backend(provider: string, fixtures: Record<string, string[]>): FreeTextBackend {
  return {
    provider,
    healthCheck: async () => ({ provider, healthy: true }),
    store: async () => true,
    list: async () => [],
    forget: async () => null,
    search: async (query) => (fixtures[query] ?? []).map((text, idx) => ({
      id: `${provider}-${idx}`,
      text,
      category: "general",
      source: "memu_item" as const,
      scope,
    })),
  };
}

console.log("\nBenchmark Tests\n");

await test("benchmarkBackends compares multiple queries", async () => {
  const primary = backend("mem0", {
    q1: ["tea"],
    q2: ["coffee", "latte"],
  });
  const shadow = backend("memu", {
    q1: ["tea"],
    q2: ["mocha"],
  });

  const rows = await benchmarkBackends(primary, shadow, scope, ["q1", "q2"], {
    maxItems: 5,
  });

  assertEqual(rows.length, 2, "row count");
  assertEqual(rows[0]?.overlapCount, 1, "q1 overlap");
  assertEqual(rows[1]?.primaryCount, 2, "q2 primary count");
  assertEqual(rows[1]?.shadowCount, 1, "q2 shadow count");
  assertEqual(rows[1]?.primaryTop, "coffee", "q2 primary top");
});

await test("formatBenchmarkReport includes top hits and uniques", () => {
  const report = formatBenchmarkReport("mem0", "memu", [
    {
      query: "drink",
      primaryCount: 1,
      shadowCount: 0,
      overlapCount: 0,
      primaryTop: "tea",
      shadowTop: undefined,
      primaryOnly: [{ id: "1", text: "tea", category: "general", source: "memu_item" as const, scope }],
      shadowOnly: [],
    },
  ]);

  assert(report.includes("Primary: mem0"), "includes primary provider");
  assert(report.includes("Query: drink"), "includes query");
  assert(report.includes("mem0-only: tea"), "includes unique item");
});

await test("benchmarkSearchProfiles summarizes durable and transient hits", async () => {
  const profileBackend: FreeTextBackend = {
    provider: "mem0",
    healthCheck: async () => ({ provider: "mem0", healthy: true }),
    store: async () => true,
    list: async () => [],
    forget: async () => null,
    search: async (_query, _scope, options) => {
      if (options?.quality === "durable" && options?.memoryKinds?.includes("preference")) {
        return [{ id: "1", text: "tea", category: "general", source: "memu_item" as const, scope, metadata: { quality: "durable", memory_kind: "preference" } }];
      }
      if (options?.quality === "durable") {
        return [{ id: "1", text: "tea", category: "general", source: "memu_item" as const, scope, metadata: { quality: "durable", memory_kind: "preference" } }];
      }
      return [
        { id: "2", text: "temporary tea note", category: "general", source: "memu_item" as const, scope, metadata: { quality: "transient", memory_kind: "schedule" } },
        { id: "1", text: "tea", category: "general", source: "memu_item" as const, scope, metadata: { quality: "durable", memory_kind: "preference" } },
      ];
    },
  };

  const rows = await benchmarkSearchProfiles(profileBackend, scope, [{
    id: "drink",
    query: "What drink?",
    expected: "tea",
    expectedKind: "preference",
  }], [
    { name: "baseline" },
    { name: "durable_only", options: { quality: "durable" } },
    { name: "durable_plus_kind", options: { quality: "durable", memoryKinds: ["preference"] } },
  ], { maxItems: 5 });

  const summary = summarizeSearchBenchmark(rows);
  assertEqual(rows.length, 1, "profile row count");
  assertEqual(rows[0]?.profiles[0]?.transientCount, 1, "baseline transient count");
  assertEqual(rows[0]?.profiles[1]?.transientCount, 0, "durable filter removes transient");
  assertEqual(rows[0]?.profiles[2]?.expectedKindHits, 1, "kind-aware filter keeps expected kind");
  assertEqual(summary[0]?.name, "baseline", "summary first profile");
  const report = formatSearchBenchmarkReport(rows);
  assert(report.includes("Metadata Search Benchmark"), "includes report header");
  assert(report.includes("durable_only"), "includes durable profile");
});

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
