// ============================================================================
// Unit Tests for CoreMemoryRepository normalization
// Run with: npx tsx tests/core-repository.test.ts
// ============================================================================

import { CoreMemoryRepository } from "../core-repository.js";
import type { MemoryScope } from "../types.js";

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

const testLogger = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
};

const scope: MemoryScope = {
  userId: "user_test",
  agentId: "agent_test",
  sessionKey: "agent:agent_test",
};

console.log("\nCore Repository Tests\n");

await test("list normalizes /core/list items shape and preserves key/value/category", async () => {
  const client = {
    coreList: async () => ({
      status: "success",
      items: [
        {
          id: "7fd3f2ea-93c9-4d7f-aedc-2f239f8d87f6",
          category: "profile",
          key: "profile.name",
          value: "Alice Doe",
          created_at: "2026-03-01T12:00:00.000Z",
          updated_at: "2026-03-02T12:00:00.000Z",
        },
      ],
      total: 1,
      limit: 20,
    }),
  } as any;

  const repo = new CoreMemoryRepository(client, testLogger, 240);
  const records = await repo.list(scope, { limit: 20 });

  assertEqual(records.length, 1, "record count");
  assertEqual(records[0]?.id, "7fd3f2ea-93c9-4d7f-aedc-2f239f8d87f6", "id");
  assertEqual(records[0]?.category, "profile", "category");
  assertEqual(records[0]?.key, "profile.name", "key preserved");
  assertEqual(records[0]?.value, "Alice Doe", "value preserved");
  assert(typeof records[0]?.createdAt === "number", "createdAt parsed");
  assert(typeof records[0]?.updatedAt === "number", "updatedAt parsed");
});

await test("list ignores non-success status", async () => {
  const client = {
    coreList: async () => ({
      status: "error",
      items: [{ id: "x", category: "profile", key: "profile.name", value: "Alice" }],
      total: 1,
      limit: 20,
    }),
  } as any;

  const repo = new CoreMemoryRepository(client, testLogger, 240);
  const records = await repo.list(scope, { limit: 20 });
  assertEqual(records.length, 0, "should return empty list");
});

await test("list ranks Chinese query-matching core facts above irrelevant high-importance facts", async () => {
  let seenLimit: number | undefined;
  const client = {
    coreList: async ({ limit }: { limit?: number }) => {
      seenLimit = limit;
      return ({
      status: "success",
      items: [
        {
          id: "role",
          category: "identity",
          key: "identity.current_role",
          value: "用户现在的职业是某互联网公司高级后端工程师。",
          importance: 10,
          updated_at: "2026-03-02T12:00:00.000Z",
        },
        {
          id: "tz",
          category: "identity",
          key: "identity.timezone",
          value: "用户的时区是 UTC+8。",
          importance: 8,
          updated_at: "2026-03-01T12:00:00.000Z",
        },
      ],
      total: 2,
      limit: 20,
    });
    },
  } as any;

  const repo = new CoreMemoryRepository(client, testLogger, 240);
  const records = await repo.list(scope, { query: "用户的时区是什么？", limit: 2 });
  assertEqual(seenLimit, 50, "query fetch should request a larger candidate pool");
  assertEqual(records[0]?.key, "identity.timezone", "timezone fact should rank first");
});

// -- Summary --
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
