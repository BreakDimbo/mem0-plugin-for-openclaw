// ============================================================================
// Tests: Outbox dead-letter persistence and replay (T5)
// Run with: npx tsx tests/outbox-dead-letter.test.ts
// ============================================================================

import { OutboxWorker } from "../outbox.js";
import type { FreeTextBackend } from "../backends/free-text/base.js";
import type { MemoryScope, ConversationMessage, DeadLetterItem } from "../types.js";
import { mkdtemp, readFile } from "node:fs/promises";
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

const logger = { info: (_: string) => {}, warn: (_: string) => {} };
const scope: MemoryScope = { userId: "u1", agentId: "main", sessionKey: "s1" };

function alwaysFailBackend(): FreeTextBackend {
  return {
    provider: "mock-fail",
    healthCheck: async () => ({ provider: "mock-fail", healthy: false }),
    store: async () => false,
    search: async () => [],
    forget: async () => null,
    list: async () => [],
  };
}

function alwaysSucceedBackend(): FreeTextBackend {
  return {
    provider: "mock-ok",
    healthCheck: async () => ({ provider: "mock-ok", healthy: true }),
    store: async () => true,
    search: async () => [],
    forget: async () => null,
    list: async () => [],
  };
}

async function makeOutbox(backend: FreeTextBackend, dir: string, maxRetries = 2) {
  const outbox = new OutboxWorker(backend, logger, {
    concurrency: 1,
    batchSize: 10,
    maxRetries,
    persistPath: dir,
    flushIntervalMs: 60_000,
  });
  await outbox.loadFromDisk();
  return outbox;
}

function makeDeadLetterItem(id: string): DeadLetterItem {
  return {
    id,
    createdAt: Date.now() - 10_000,
    scope,
    payload: { messages: [{ role: "user" as const, content: `Test message for ${id}` }] },
    retryCount: 5,
    nextRetryAt: 0,
    failedAt: Date.now() - 5_000,
    lastError: "store returned false",
  };
}

console.log("\nOutbox Dead-Letter Tests (T5)\n");

// Test 1: Dead-letter items are recoverable after restart
await test("dead-letter loaded from disk after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-dl-"));
  const outbox1 = await makeOutbox(alwaysFailBackend(), dir);

  // Manually add a dead-letter and save
  (outbox1 as any).deadLetters.push(makeDeadLetterItem("dl-001"));
  await (outbox1 as any).saveDeadLetters();

  // Simulate restart
  const outbox2 = await makeOutbox(alwaysFailBackend(), dir);
  assertEqual(outbox2.deadLetterCount, 1, "dead-letter loaded from disk");
  assertEqual(outbox2.getDeadLetters()[0].id, "dl-001", "correct id loaded");
});

// Test 2: replayDeadLetters() moves items to queue and clears dead-letters
await test("replayDeadLetters() moves all items back to queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-dl-"));
  const outbox = await makeOutbox(alwaysSucceedBackend(), dir);

  (outbox as any).deadLetters.push(makeDeadLetterItem("dl-a"));
  (outbox as any).deadLetters.push(makeDeadLetterItem("dl-b"));
  assertEqual(outbox.deadLetterCount, 2, "2 dead-letters before replay");

  const result = await outbox.replayDeadLetters();
  assertEqual(result.replayed, 2, "2 items replayed");
  assertEqual(result.skipped, 0, "0 items skipped");
  assertEqual(outbox.deadLetterCount, 0, "dead-letters cleared after replay");
  assert(outbox.pending >= 2, "items added to queue");
  // retryCount should be reset
  const queueItems = (outbox as any).queue as Array<{ id: string; retryCount: number }>;
  assert(queueItems.every((q) => q.retryCount === 0), "retryCount reset to 0");
});

// Test 3: replayDeadLetters(ids) only replays specified ids
await test("replayDeadLetters([id]) only replays matching item", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-dl-"));
  const outbox = await makeOutbox(alwaysSucceedBackend(), dir);

  (outbox as any).deadLetters.push(makeDeadLetterItem("dl-x"));
  (outbox as any).deadLetters.push(makeDeadLetterItem("dl-y"));

  const result = await outbox.replayDeadLetters(["dl-x"]);
  assertEqual(result.replayed, 1, "1 item replayed");
  assertEqual(outbox.deadLetterCount, 1, "dl-y still in dead-letters");
  assertEqual(outbox.getDeadLetters()[0].id, "dl-y", "dl-y remains");
  const queueIds = ((outbox as any).queue as Array<{ id: string }>).map((q) => q.id);
  assert(queueIds.includes("dl-x"), "dl-x in queue");
  assert(!queueIds.includes("dl-y"), "dl-y not in queue");
});

// Test 4: saveDeadLetters() persists to correct path
await test("saveDeadLetters() writes readable file with correct content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-dl-"));
  const outbox = await makeOutbox(alwaysFailBackend(), dir);

  (outbox as any).deadLetters.push(makeDeadLetterItem("dl-persist"));
  await (outbox as any).saveDeadLetters();

  const raw = await readFile(join(dir, "outbox-deadletter.json"), "utf-8");
  const parsed = JSON.parse(raw) as Array<{ id: string }>;
  assert(Array.isArray(parsed), "file contains array");
  assert(parsed.some((item) => item.id === "dl-persist"), "contains expected item id");
});

// Test 5: Dead-letter cap — loading 600 items keeps only 500
await test("dead-letters capped at 500 on flush overflow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-dl-"));
  const outbox = await makeOutbox(alwaysFailBackend(), dir, 1); // maxRetries=1

  // Seed 600 dead-letter items directly
  const items: DeadLetterItem[] = Array.from({ length: 600 }, (_, i) =>
    makeDeadLetterItem(`dl-${i.toString().padStart(4, "0")}`),
  );
  (outbox as any).deadLetters = items;

  // Trigger a flush that would normally push more dead-letters
  // Add a new failing item and flush (forces the cap check in the flush path)
  (outbox as any).queue.push({
    id: "new-fail",
    createdAt: Date.now(),
    scope,
    payload: { messages: [{ role: "user", content: "new failing message" }] },
    retryCount: 1, // already at maxRetries-1, so next failure = dead-letter
    nextRetryAt: 0,
  });
  await outbox.flush();

  assert(outbox.deadLetterCount <= 500, `dead-letters capped at 500, got ${outbox.deadLetterCount}`);
});

// Summary
console.log();
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
