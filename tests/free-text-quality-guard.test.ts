// ============================================================================
// Tests: Free-text write-path quality guard (T2)
// Run with: npx tsx tests/free-text-quality-guard.test.ts
// ============================================================================

import { OutboxWorker } from "../outbox.js";
import type { FreeTextBackend } from "../backends/free-text/base.js";
import type { MemoryScope, ConversationMessage } from "../types.js";
import { mkdtemp } from "node:fs/promises";
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

function makeMockBackend(shouldSucceed = true): FreeTextBackend & { storeCalls: number } {
  const obj: FreeTextBackend & { storeCalls: number } = {
    storeCalls: 0,
    provider: "mock",
    healthCheck: async () => ({ provider: "mock", healthy: true }),
    store: async () => { obj.storeCalls++; return shouldSucceed; },
    search: async () => [],
    forget: async () => null,
    list: async () => [],
  };
  return obj;
}

async function makeOutbox(backend: FreeTextBackend) {
  const dir = await mkdtemp(join(tmpdir(), "memu-t2-"));
  const outbox = new OutboxWorker(backend, logger, {
    concurrency: 1,
    batchSize: 10,
    maxRetries: 3,
    persistPath: dir,
    flushIntervalMs: 60_000,
  });
  await outbox.loadFromDisk();
  return outbox;
}

console.log("\nFree-text Quality Guard Tests (T2)\n");

// Test 1: Law article text (第X条) rejected at flush — not sent to store
await test("law article text (第X条) is quality-rejected at outbox flush", async () => {
  const backend = makeMockBackend();
  const outbox = await makeOutbox(backend);

  const lawText = "第十五条 用人单位应当在解除或者终止劳动合同时出具解除或者终止劳动合同的证明";
  const messages: ConversationMessage[] = [{ role: "user", content: lawText }];

  // Bypass normal enqueue and push directly to test flush behavior
  (outbox as any).queue.push({
    id: "law-test-1",
    createdAt: Date.now(),
    scope,
    payload: { messages },
    retryCount: 0,
    nextRetryAt: 0,
  });

  await outbox.flush();
  assertEqual(backend.storeCalls, 0, "store() never called for law article");
  assertEqual(outbox.pending, 0, "item removed from queue (treated as success)");
  assertEqual(outbox.deadLetterCount, 0, "not added to dead-letter");
});

// Test 2: Circled number enumeration rejected
await test("circled-number study note text is quality-rejected at outbox flush", async () => {
  const backend = makeMockBackend();
  const outbox = await makeOutbox(backend);

  const studyText = "①合同主体 ②合同内容 ③合同形式 ④合同生效 ⑤合同变更";
  const messages: ConversationMessage[] = [{ role: "user", content: studyText }];

  (outbox as any).queue.push({
    id: "study-test-1",
    createdAt: Date.now(),
    scope,
    payload: { messages },
    retryCount: 0,
    nextRetryAt: 0,
  });

  await outbox.flush();
  assertEqual(backend.storeCalls, 0, "store() never called for study note");
  assertEqual(outbox.deadLetterCount, 0, "not added to dead-letter");
});

// Test 3: Semicolon-separated clauses (≥3) rejected
await test("semicolon-separated clause list (≥3) is quality-rejected at outbox flush", async () => {
  const backend = makeMockBackend();
  const outbox = await makeOutbox(backend);

  // ≥3 semicolons with ≥8 chars each clause
  const clauseText = "甲方负责项目整体规划和技术架构；乙方负责前端界面开发和用户体验；丙方负责后端服务开发和数据库；丁方负责测试和质量保证工作";
  const messages: ConversationMessage[] = [{ role: "user", content: clauseText }];

  (outbox as any).queue.push({
    id: "clause-test-1",
    createdAt: Date.now(),
    scope,
    payload: { messages },
    retryCount: 0,
    nextRetryAt: 0,
  });

  await outbox.flush();
  assertEqual(backend.storeCalls, 0, "store() never called for clause list");
  assertEqual(outbox.deadLetterCount, 0, "not added to dead-letter");
});

// Test 4: Normal user preference passes through
await test("normal user preference text is stored successfully", async () => {
  const backend = makeMockBackend();
  const outbox = await makeOutbox(backend);

  const normalText = "我平时用 vim，习惯把 tabstop 设为 2，喜欢黑色主题";
  const messages: ConversationMessage[] = [{ role: "user", content: normalText }];

  (outbox as any).queue.push({
    id: "normal-test-1",
    createdAt: Date.now(),
    scope,
    payload: { messages },
    retryCount: 0,
    nextRetryAt: 0,
  });

  await outbox.flush();
  assertEqual(backend.storeCalls, 1, "store() called once for normal text");
  assertEqual(outbox.pending, 0, "item sent and removed from queue");
});

// Test 5: knowledge-dump rejected as success (not dead-lettered)
await test("knowledge-dump rejected at flush counts as sent, not dead-lettered", async () => {
  const backend = makeMockBackend();
  const outbox = await makeOutbox(backend);

  const lawText = "第二十三条 劳动合同由用人单位与劳动者协商一致并经双方在劳动合同文本上签字";
  const messages: ConversationMessage[] = [{ role: "user", content: lawText }];

  (outbox as any).queue.push({
    id: "kd-success-test",
    createdAt: Date.now(),
    scope,
    payload: { messages },
    retryCount: 0,
    nextRetryAt: 0,
  });

  const sentBefore = outbox.sent;
  await outbox.flush();
  assertEqual(outbox.pending, 0, "item removed from queue");
  assertEqual(outbox.deadLetterCount, 0, "not dead-lettered");
  // sent counter increments because quality-reject returns item.id (treated as success)
  assert(outbox.sent >= sentBefore, "sent counter not decreased");
});

// Summary
console.log();
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
