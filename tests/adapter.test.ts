// ============================================================================
// Unit Tests for MemUAdapter Recall
// Run with: npx tsx tests/adapter.test.ts
// ============================================================================

import { MemUAdapter } from "../adapter.js";
import type { MemUClient } from "../client.js";
import type { RetrieveHybridParams, RetrieveParams } from "../client.js";
import type { ScopeConfig } from "../types.js";

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

const scopeConfig: ScopeConfig = {
  userId: "default_user",
  agentId: "default_agent",
  requireUserId: true,
  requireAgentId: true,
  isolateByChannel: true,
  isolateByThread: true,
};

console.log("\nMemUAdapter Recall Tests\n");

await test("recall uses /retrieve/hybrid when enabled", async () => {
  let retrieveCalls = 0;
  let hybridCalls = 0;
  let hybridParams: RetrieveHybridParams | undefined;

  const logger = {
    info: (_msg: string) => {},
    warn: (_msg: string) => {},
  };

  const client = {
    retrieve: async (_params: RetrieveParams) => {
      retrieveCalls++;
      return { status: "success", result: { items: [] } };
    },
    retrieveHybrid: async (params: RetrieveHybridParams) => {
      hybridCalls++;
      hybridParams = params;
      return {
        status: "success",
        results: [
          { id: "h1", text: "hybrid memory 1", score: 0.91, vscore: 0.95, tscore: 0.81 },
          { id: "h2", text: "hybrid memory 2", score: 0.87, vscore: 0.90, tscore: 0.80 },
        ],
        total: 2,
      };
    },
  } as unknown as MemUClient;

  const adapter = new MemUAdapter(client, scopeConfig, logger, "rag", {
    enabled: true,
    alpha: 0.7,
    fallbackToRag: true,
  });

  const out = await adapter.recall("what did I say?", { userId: "u1", agentId: "a1", sessionKey: "agent:a1" }, { maxItems: 2 });

  assertEqual(hybridCalls, 1, "hybrid call count");
  assertEqual(retrieveCalls, 0, "rag call count");
  assertEqual(hybridParams?.user_id, "u1", "hybrid user_id");
  assertEqual(hybridParams?.agent_id, "a1", "hybrid agent_id");
  assertEqual(hybridParams?.limit, 2, "hybrid limit");
  assertEqual(hybridParams?.alpha, 0.7, "hybrid alpha");
  assertEqual(out.length, 2, "result length");
  assertEqual(out[0]?.category, "hybrid", "result category");
  assertEqual(out[0]?.metadata?.vscore, 0.95, "result metadata vscore");
  assertEqual(out[0]?.metadata?.tscore, 0.81, "result metadata tscore");
});

await test("recall falls back to /retrieve when hybrid fails and fallback enabled", async () => {
  let retrieveCalls = 0;
  let hybridCalls = 0;
  const warns: string[] = [];

  const logger = {
    info: (_msg: string) => {},
    warn: (msg: string) => warns.push(msg),
  };

  const client = {
    retrieve: async (_params: RetrieveParams) => {
      retrieveCalls++;
      return {
        status: "success",
        result: {
          items: [{ id: "r1", text: "rag memory", category: "general", score: 0.7 }],
        },
      };
    },
    retrieveHybrid: async (_params: RetrieveHybridParams) => {
      hybridCalls++;
      throw new Error("boom");
    },
  } as unknown as MemUClient;

  const adapter = new MemUAdapter(client, scopeConfig, logger, "rag", {
    enabled: true,
    alpha: 0.6,
    fallbackToRag: true,
  });

  const out = await adapter.recall("fallback query", { userId: "u2", agentId: "a2", sessionKey: "agent:a2" }, { maxItems: 3 });

  assertEqual(hybridCalls, 1, "hybrid call count");
  assertEqual(retrieveCalls, 1, "rag call count");
  assertEqual(out.length, 1, "result length");
  assertEqual(out[0]?.text, "rag memory", "fallback result text");
  assert(warns.some((w) => w.includes("memu-adapter: hybrid recall failed, falling back to /retrieve")), "fallback warning logged");
});

// -- Summary --
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
