// ============================================================================
// Unit Tests for Outbox Worker
// Run with: npx tsx tests/outbox.test.ts
// ============================================================================

import type { MemUAdapter } from "../adapter.js";
import { OutboxWorker } from "../outbox.js";
import type { MemoryScope } from "../types.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

// Mock adapter
function createMockAdapter(shouldSucceed = true): MemUAdapter {
  return {
    memorize: async () => shouldSucceed,
    recall: async () => [],
    forget: async () => null,
    listCategories: async () => [],
    getDefaultScope: () => ({ userId: "test", agentId: "test", sessionKey: "test" }),
  } as unknown as MemUAdapter;
}

const testLogger = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
};

const testScope: MemoryScope = {
  userId: "test_user",
  agentId: "test_agent",
  sessionKey: "agent:test_agent",
};

console.log("\nOutbox Worker Tests\n");

await test("enqueue adds items", async () => {
  const outbox = new OutboxWorker(createMockAdapter(), testLogger, {
    concurrency: 2,
    batchSize: 10,
    maxRetries: 3,
    persistPath: "",
  });

  outbox.enqueue("test text 1", testScope);
  assertEqual(outbox.pending, 1, "pending");
});

await test("dedup prevents duplicate enqueue", async () => {
  const outbox = new OutboxWorker(createMockAdapter(), testLogger, {
    concurrency: 2,
    batchSize: 10,
    maxRetries: 3,
    persistPath: "",
  });

  outbox.enqueue("same text", testScope);
  outbox.enqueue("same text", testScope);
  assertEqual(outbox.pending, 1, "should dedup");
});

await test("flush sends items successfully", async () => {
  const outbox = new OutboxWorker(createMockAdapter(true), testLogger, {
    concurrency: 2,
    batchSize: 10,
    maxRetries: 3,
    persistPath: "",
  });

  outbox.enqueue("flush test", testScope);
  await outbox.flush();
  assertEqual(outbox.pending, 0, "pending after flush");
  assertEqual(outbox.sent, 1, "sent count");
});

await test("flush retries on failure", async () => {
  const outbox = new OutboxWorker(createMockAdapter(false), testLogger, {
    concurrency: 2,
    batchSize: 10,
    maxRetries: 3,
    persistPath: "",
  });

  outbox.enqueue("retry test", testScope);
  await outbox.flush();
  assertEqual(outbox.pending, 1, "still pending after first failure");
  assertEqual(outbox.sent, 0, "not sent yet");
});

await test("items move to dead-letter after max retries", async () => {
  const outbox = new OutboxWorker(createMockAdapter(false), testLogger, {
    concurrency: 2,
    batchSize: 10,
    maxRetries: 1,
    persistPath: "",
  });

  outbox.enqueue("dead letter test", testScope);
  await outbox.flush();
  assertEqual(outbox.pending, 0, "removed from queue");
  assertEqual(outbox.failed, 1, "failed count");
  assertEqual(outbox.deadLetterCount, 1, "dead letter count");
});

await test("drain processes all items", async () => {
  const outbox = new OutboxWorker(createMockAdapter(true), testLogger, {
    concurrency: 2,
    batchSize: 10,
    maxRetries: 3,
    persistPath: "",
  });

  outbox.enqueue("drain test 1", testScope);
  outbox.enqueue("drain test 2 unique text", testScope);
  await outbox.drain(5000);
  assertEqual(outbox.pending, 0, "all drained");
  assertEqual(outbox.sent, 2, "both sent");
});

await test("start loads pending items from disk and flushes them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-outbox-"));
  const queueFile = join(dir, "outbox-queue.json");
  await writeFile(
    queueFile,
    JSON.stringify([
      {
        id: "persisted-1",
        createdAt: Date.now(),
        scope: testScope,
        payload: { text: "persisted text" },
        retryCount: 0,
        nextRetryAt: 0,
      },
    ]),
    "utf-8",
  );

  const outbox = new OutboxWorker(createMockAdapter(true), testLogger, {
    concurrency: 2,
    batchSize: 10,
    maxRetries: 3,
    persistPath: dir,
    flushIntervalMs: 60_000,
  });

  await outbox.start();
  outbox.stop();

  assertEqual(outbox.sent, 1, "persisted item should be flushed on start");
  assertEqual(outbox.pending, 0, "queue should be empty after startup flush");
  const saved = JSON.parse(await readFile(queueFile, "utf-8"));
  assertEqual(Array.isArray(saved) ? saved.length : -1, 0, "queue file should be rewritten as empty");
});

await test("load merges legacy shard queue files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-outbox-"));
  await writeFile(join(dir, "outbox-queue.json"), "[]", "utf-8");
  await writeFile(
    join(dir, "outbox-queue-growth_hacker.json"),
    JSON.stringify([
      {
        id: "legacy-growth",
        createdAt: Date.now(),
        scope: { ...testScope, agentId: "growth_hacker", sessionKey: "agent:growth_hacker:main" },
        payload: { text: "legacy shard item" },
        retryCount: 0,
        nextRetryAt: 0,
      },
    ]),
    "utf-8",
  );

  const outbox = new OutboxWorker(createMockAdapter(true), testLogger, {
    concurrency: 2,
    batchSize: 10,
    maxRetries: 3,
    persistPath: dir,
    flushIntervalMs: 60_000,
  });

  await outbox.start();
  outbox.stop();

  assertEqual(outbox.sent, 1, "legacy shard item should be merged and flushed");
  assertEqual(outbox.pending, 0, "legacy shard item should not remain pending");
  const legacySaved = JSON.parse(await readFile(join(dir, "outbox-queue-growth_hacker.json"), "utf-8"));
  assertEqual(Array.isArray(legacySaved) ? legacySaved.length : -1, 0, "legacy shard file should be cleared after merge");
});

// -- Summary --
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
