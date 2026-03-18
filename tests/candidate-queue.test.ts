// ============================================================================
// Unit Tests for CandidateQueue
// Run with: npx tsx tests/candidate-queue.test.ts
// ============================================================================

import { CandidateQueue } from "../candidate-queue.js";
import type { CandidateItem } from "../candidate-queue.js";
import type { MemoryScope, ConversationMessage } from "../types.js";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";

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

const testLogger = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
};

const testScope: MemoryScope = {
  userId: "test_user",
  agentId: "test_agent",
  sessionKey: "agent:test_agent",
};

// Helper to wrap text in message array
function msg(text: string): ConversationMessage[] {
  return [{ role: "user", content: text }];
}

// Helper to get text from messages
function getText(item: CandidateItem): string {
  const lastUser = [...item.messages].reverse().find(m => m.role === "user");
  return lastUser?.content ?? "";
}

console.log("\nCandidateQueue Tests\n");

await test("enqueue adds items and updates pending count", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cq-test-"));
  const processed: CandidateItem[][] = [];
  const cq = new CandidateQueue(
    async (batch) => { processed.push(batch); },
    testLogger,
    { intervalMs: 60_000, maxBatchSize: 10, persistPath: tmpDir },
  );

  cq.enqueue(msg("我叫小明"), testScope);
  cq.enqueue(msg("我在字节跳动工作"), testScope);

  assertEqual(cq.pending, 2, "pending count");
  assertEqual(cq.enqueued, 2, "enqueued count");

  cq.stop();
});

await test("enqueue deduplicates same text+scope", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cq-test-"));
  const cq = new CandidateQueue(
    async () => {},
    testLogger,
    { intervalMs: 60_000, maxBatchSize: 10, persistPath: tmpDir },
  );

  cq.enqueue(msg("我叫小明"), testScope);
  cq.enqueue(msg("我叫小明"), testScope); // duplicate

  assertEqual(cq.pending, 1, "pending should be 1 after dedup");
  assertEqual(cq.enqueued, 1, "enqueued should be 1");
  assertEqual(cq.dropped, 1, "dropped should be 1");

  cq.stop();
});

await test("enqueue allows same text with different scope", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cq-test-"));
  const cq = new CandidateQueue(
    async () => {},
    testLogger,
    { intervalMs: 60_000, maxBatchSize: 10, persistPath: tmpDir },
  );

  const scope2: MemoryScope = { ...testScope, userId: "other_user" };
  cq.enqueue(msg("我叫小明"), testScope);
  cq.enqueue(msg("我叫小明"), scope2);

  assertEqual(cq.pending, 2, "different scopes should not dedup");

  cq.stop();
});

await test("processBatch calls processor with all items", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cq-test-"));
  const batches: CandidateItem[][] = [];
  const cq = new CandidateQueue(
    async (batch) => { batches.push([...batch]); },
    testLogger,
    { intervalMs: 60_000, maxBatchSize: 10, persistPath: tmpDir },
  );

  cq.enqueue(msg("fact one"), testScope);
  cq.enqueue(msg("fact two"), testScope);
  await cq.processBatch();

  assertEqual(batches.length, 1, "should have 1 batch");
  assertEqual(batches[0].length, 2, "batch should have 2 items");
  assertEqual(getText(batches[0][0]), "fact one", "first item text");
  assertEqual(getText(batches[0][1]), "fact two", "second item text");
  assertEqual(cq.pending, 0, "pending should be 0 after processing");
  assertEqual(cq.processed, 2, "processed count");

  cq.stop();
});

await test("processBatch respects maxBatchSize", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cq-test-"));
  const batches: CandidateItem[][] = [];
  const cq = new CandidateQueue(
    async (batch) => { batches.push([...batch]); },
    testLogger,
    { intervalMs: 60_000, maxBatchSize: 2, persistPath: tmpDir },
  );

  cq.enqueue(msg("fact one"), testScope);
  cq.enqueue(msg("fact two"), testScope);
  cq.enqueue(msg("fact three"), testScope);

  await cq.processBatch();
  assertEqual(batches.length, 1, "first batch call");
  assertEqual(batches[0].length, 2, "batch capped at maxBatchSize=2");
  assertEqual(cq.pending, 1, "1 item remaining");

  await cq.processBatch();
  assertEqual(batches.length, 2, "second batch call");
  assertEqual(batches[1].length, 1, "remaining item");
  assertEqual(cq.pending, 0, "all processed");

  cq.stop();
});

await test("processBatch is no-op on empty queue", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cq-test-"));
  let called = false;
  const cq = new CandidateQueue(
    async () => { called = true; },
    testLogger,
    { intervalMs: 60_000, maxBatchSize: 10, persistPath: tmpDir },
  );

  await cq.processBatch();
  assert(!called, "processor should not be called on empty queue");

  cq.stop();
});

await test("drain processes all pending items", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cq-test-"));
  const processed: string[] = [];
  const cq = new CandidateQueue(
    async (batch) => { for (const item of batch) processed.push(getText(item)); },
    testLogger,
    { intervalMs: 60_000, maxBatchSize: 2, persistPath: tmpDir },
  );

  cq.enqueue(msg("a"), testScope);
  cq.enqueue(msg("b"), testScope);
  cq.enqueue(msg("c"), testScope);

  await cq.drain(5_000);

  assertEqual(processed.length, 3, "all 3 items should be processed by drain");
  assertEqual(cq.pending, 0, "nothing pending after drain");

  cq.stop();
});

await test("start loads persisted items and processes them", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cq-test-"));
  const persistFile = join(tmpDir, "candidate-queue.json");

  // Pre-seed persistence file with new format
  const seeded: CandidateItem[] = [
    { id: "abc123", messages: [{ role: "user", content: "persisted fact" }], scope: testScope, receivedAt: Date.now() },
  ];
  const { writeFile } = await import("node:fs/promises");
  await writeFile(persistFile, JSON.stringify(seeded), "utf-8");

  const processed: string[] = [];
  const cq = new CandidateQueue(
    async (batch) => { for (const item of batch) processed.push(getText(item)); },
    testLogger,
    { intervalMs: 60_000, maxBatchSize: 10, persistPath: tmpDir },
  );

  await cq.start();

  // start() should load and process persisted items immediately
  assertEqual(processed.length, 1, "persisted item should be processed on start");
  assertEqual(processed[0], "persisted fact", "correct text");

  cq.stop();
});

await test("start migrates legacy persisted text items", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cq-test-"));
  const persistFile = join(tmpDir, "candidate-queue.json");

  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    persistFile,
    JSON.stringify([
      { id: "legacy-1", text: "legacy persisted fact", scope: testScope, receivedAt: Date.now() },
    ]),
    "utf-8",
  );

  const processed: string[] = [];
  const cq = new CandidateQueue(
    async (batch) => { for (const item of batch) processed.push(getText(item)); },
    testLogger,
    { intervalMs: 60_000, maxBatchSize: 10, persistPath: tmpDir },
  );

  await cq.start();

  assertEqual(processed.length, 1, "legacy item should be processed on start");
  assertEqual(processed[0], "legacy persisted fact", "legacy text should be migrated into messages");

  cq.stop();
});

await test("persistence survives stop/start cycle", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cq-test-"));

  // Phase 1: enqueue items, don't process — use drain() to ensure persistence
  const cq1 = new CandidateQueue(
    async () => {}, // no-op processor (items stay since processBatch splices them)
    testLogger,
    { intervalMs: 60_000, maxBatchSize: 10, persistPath: tmpDir },
  );
  await cq1.start(); // load (empty), start timer
  cq1.enqueue(msg("surviving fact"), testScope);
  // drain calls saveToDisk, but also processes — we need items to persist.
  // Instead, wait briefly for the fire-and-forget saveToDisk from enqueue.
  await new Promise((r) => setTimeout(r, 100));
  cq1.stop();

  // Verify file exists
  const raw = await readFile(join(tmpDir, "candidate-queue.json"), "utf-8");
  const items = JSON.parse(raw);
  assertEqual(items.length, 1, "1 item persisted to disk");

  // Phase 2: new instance loads persisted items
  const processed: string[] = [];
  const cq2 = new CandidateQueue(
    async (batch) => { for (const item of batch) processed.push(getText(item)); },
    testLogger,
    { intervalMs: 60_000, maxBatchSize: 10, persistPath: tmpDir },
  );
  await cq2.start();

  assertEqual(processed.length, 1, "loaded and processed persisted item");
  assertEqual(processed[0], "surviving fact", "correct text");
  cq2.stop();
});

await test("enqueue preserves metadata", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cq-test-"));
  const batches: CandidateItem[][] = [];
  const cq = new CandidateQueue(
    async (batch) => { batches.push([...batch]); },
    testLogger,
    { intervalMs: 60_000, maxBatchSize: 10, persistPath: tmpDir },
  );

  cq.enqueue(msg("some fact"), testScope, { channel: "feishu", extra: 42 });
  await cq.processBatch();

  assertEqual(batches[0][0].metadata?.channel, "feishu", "metadata preserved");
  assertEqual(batches[0][0].metadata?.extra, 42, "metadata extra field");

  cq.stop();
});

// ============================================================================
// Summary
// ============================================================================

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;

console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);

if (failed > 0) {
  console.log("\nFailed tests:");
  for (const r of results.filter((r) => !r.passed)) {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  }
  process.exit(1);
}
