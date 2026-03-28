// ============================================================================
// Tests: Garbage memory filtering — low-value write prevention (L1) and
//        output-layer recall suppression (L2)
// Run with: npx tsx tests/garbage-filter.test.ts
// ============================================================================

import { OutboxWorker } from "../outbox.js";
import { Mem0FreeTextBackend } from "../backends/free-text/mem0.js";
import { loadConfig } from "../types.js";
import type { FreeTextBackend } from "../backends/free-text/base.js";
import type { MemoryScope, MemuPluginConfig } from "../types.js";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
const scope: MemoryScope = { userId: "u1", agentId: "main", sessionKey: "s1" };

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(): MemuPluginConfig {
  return loadConfig({ mem0: { mode: "open-source" } });
}

type MockItem = {
  id?: string;
  memory?: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

function makeMockProvider(getAllItems: MockItem[] = [], searchItems: MockItem[] = []) {
  return {
    add: async () => ({ results: [{ id: "x" }] }),
    search: async () => searchItems,
    getAll: async () => getAllItems,
    delete: async () => {},
  } as any;
}

function makeOutboxItem(content: string) {
  return { messages: [{ role: "user" as const, content }] };
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

async function makeOutbox(backend: FreeTextBackend, dir: string) {
  const outbox = new OutboxWorker(backend, logger, {
    concurrency: 1,
    batchSize: 10,
    maxRetries: 1,
    persistPath: dir,
    flushIntervalMs: 60_000,
  });
  await outbox.loadFromDisk();
  return outbox;
}

console.log("\nGarbage Filter Tests\n");

// ── Layer 1: Write-prevention (outbox quality guard) ─────────────────────────

await test("L1: HEARTBEAT_OK rejected at outbox flush", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-gf-"));
  let storeCalled = 0;
  const backend: FreeTextBackend = {
    ...alwaysSucceedBackend(),
    store: async () => { storeCalled++; return true; },
  };
  const outbox = await makeOutbox(backend, dir);
  outbox.enqueue([{ role: "user", content: "HEARTBEAT_OK" }], scope);
  await (outbox as any).flush();
  assertEqual(storeCalled, 0, "store() not called for HEARTBEAT_OK");
  assertEqual(outbox.deadLetterCount, 0, "not dead-lettered (treated as success)");
});

await test("L1: 心跳检查 message rejected at outbox flush", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-gf-"));
  let storeCalled = 0;
  const backend: FreeTextBackend = {
    ...alwaysSucceedBackend(),
    store: async () => { storeCalled++; return true; },
  };
  const outbox = await makeOutbox(backend, dir);
  outbox.enqueue([{ role: "user", content: "已执行HEARTBEAT.md的心跳检查，所有检查项目均通过" }], scope);
  await (outbox as any).flush();
  assertEqual(storeCalled, 0, "store() not called for 心跳检查");
});

await test("L1: 无紧急事项 message rejected at outbox flush", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-gf-"));
  let storeCalled = 0;
  const backend: FreeTextBackend = {
    ...alwaysSucceedBackend(),
    store: async () => { storeCalled++; return true; },
  };
  const outbox = await makeOutbox(backend, dir);
  outbox.enqueue([{ role: "user", content: "无紧急事项需要关注" }], scope);
  await (outbox as any).flush();
  assertEqual(storeCalled, 0, "store() not called for 无紧急事项");
});

await test("L1: timestamp message with day-of-week rejected at outbox flush", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-gf-"));
  let storeCalled = 0;
  const backend: FreeTextBackend = {
    ...alwaysSucceedBackend(),
    store: async () => { storeCalled++; return true; },
  };
  const outbox = await makeOutbox(backend, dir);
  outbox.enqueue(
    [{ role: "user", content: "The user requested the system to read the file. The current time is Saturday, March 28, 2026." }],
    scope,
  );
  await (outbox as any).flush();
  assertEqual(storeCalled, 0, "store() not called for timestamp message");
});

await test("L1: normal preference message NOT rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memu-gf-"));
  let storeCalled = 0;
  const backend: FreeTextBackend = {
    ...alwaysSucceedBackend(),
    store: async () => { storeCalled++; return true; },
  };
  const outbox = await makeOutbox(backend, dir);
  outbox.enqueue([{ role: "user", content: "我平时用 vim，习惯把 tabstop 设为 2" }], scope);
  await (outbox as any).flush();
  assert(storeCalled > 0, "store() called for valid preference");
});

// ── Layer 2: Output-layer suppression (filterResults in backend) ──────────────

await test("L2: 'New fact added' excluded from list()", async () => {
  const items: MockItem[] = [
    { id: "garbage-1", memory: "New fact added" },
    { id: "valid-1", memory: "User prefers vim as their editor" },
  ];
  const backend = new Mem0FreeTextBackend(makeConfig(), logger, async () => makeMockProvider(items));
  const listed = await backend.list(scope);
  assert(!listed.some((r) => r.id === "garbage-1"), "'New fact added' excluded");
  assert(listed.some((r) => r.id === "valid-1"), "valid memory retained");
});

await test("L2: 'New retrieved fact 1' excluded from list()", async () => {
  const items: MockItem[] = [
    { id: "garbage-2", memory: "New retrieved fact 1" },
    { id: "garbage-3", memory: "New retrieved fact 2" },
    { id: "valid-2", memory: "User works in TypeScript" },
  ];
  const backend = new Mem0FreeTextBackend(makeConfig(), logger, async () => makeMockProvider(items));
  const listed = await backend.list(scope);
  assertEqual(listed.length, 1, "only 1 valid item");
  assertEqual(listed[0].id, "valid-2", "correct item retained");
});

await test("L2: 'Add new retrieved facts to the memory' excluded from search()", async () => {
  const items: MockItem[] = [
    { id: "garbage-4", memory: "Add new retrieved facts to the memory", score: 0.9 },
    { id: "valid-3", memory: "User prefers dark mode", score: 0.8 },
  ];
  const backend = new Mem0FreeTextBackend(makeConfig(), logger, async () => makeMockProvider([], items));
  const found = await backend.search("preferences", scope);
  assert(!found.some((r) => r.id === "garbage-4"), "system template excluded from search");
  assert(found.some((r) => r.id === "valid-3"), "valid memory in search results");
});

await test("L2: 'New retrieved facts are mentioned below...' excluded from search()", async () => {
  const items: MockItem[] = [
    { id: "garbage-5", memory: "New retrieved facts are mentioned below. Please use them.", score: 0.95 },
    { id: "valid-4", memory: "User is a TypeScript developer", score: 0.7 },
  ];
  const backend = new Mem0FreeTextBackend(makeConfig(), logger, async () => makeMockProvider([], items));
  const found = await backend.search("developer", scope);
  assert(!found.some((r) => r.id === "garbage-5"), "system prompt template excluded");
  assert(found.some((r) => r.id === "valid-4"), "valid memory returned");
});

await test("L2: legitimate memory mentioning 'fact' not incorrectly filtered", async () => {
  const items: MockItem[] = [
    { id: "valid-5", memory: "User knows an interesting fact about TypeScript: it was created by Microsoft" },
    { id: "valid-6", memory: "In fact, the user prefers tabs over spaces" },
  ];
  const backend = new Mem0FreeTextBackend(makeConfig(), logger, async () => makeMockProvider(items));
  const listed = await backend.list(scope);
  assertEqual(listed.length, 2, "legitimate 'fact' mentions not filtered");
});

// ── Layer 2: Chinese operational noise (B+C patterns) ────────────────────────

await test("L2: 无紧急事项需要关注 excluded from search()", async () => {
  const items: MockItem[] = [
    { id: "noise-1", memory: "无紧急事项需要关注", score: 0.85 },
    { id: "valid-7", memory: "用户偏好 vim 编辑器", score: 0.7 },
  ];
  const backend = new Mem0FreeTextBackend(makeConfig(), logger, async () => makeMockProvider([], items));
  const found = await backend.search("清理", scope);
  assert(!found.some((r) => r.id === "noise-1"), "无紧急事项 excluded");
  assert(found.some((r) => r.id === "valid-7"), "valid memory retained");
});

await test("L2: 心跳检查 excluded from list()", async () => {
  const items: MockItem[] = [
    { id: "noise-2", memory: "已执行心跳检查，所有检查项目均通过" },
    { id: "valid-8", memory: "用户使用 TypeScript 开发后端" },
  ];
  const backend = new Mem0FreeTextBackend(makeConfig(), logger, async () => makeMockProvider(items));
  const listed = await backend.list(scope);
  assert(!listed.some((r) => r.id === "noise-2"), "心跳检查 excluded");
  assert(listed.some((r) => r.id === "valid-8"), "valid memory retained");
});

await test("L2: structured report null-value lines excluded (无需要X的X)", async () => {
  const items: MockItem[] = [
    { id: "noise-3", memory: "4. 模式推广：无需要推广的模式", score: 0.8 },
    { id: "noise-4", memory: "2. 错误 - 重复错误：无需要解决的重复错误", score: 0.75 },
    { id: "valid-9", memory: "验证报告指出，确认窗口与 OOS 高度一致，策略无性能退化。", score: 0.7 },
  ];
  const backend = new Mem0FreeTextBackend(makeConfig(), logger, async () => makeMockProvider([], items));
  const found = await backend.search("进行清理", scope);
  assert(!found.some((r) => r.id === "noise-3"), "模式推广：无需要... excluded");
  assert(!found.some((r) => r.id === "noise-4"), "重复错误：无需要... excluded");
  assert(found.some((r) => r.id === "valid-9"), "legitimate validation report retained");
});

await test("L2: HEARTBEAT and English patterns excluded from list()", async () => {
  const items: MockItem[] = [
    { id: "noise-5", memory: "HEARTBEAT_OK status check passed" },
    { id: "noise-6", memory: "The current time is Saturday, March 28, 2026." },
    { id: "noise-7", memory: "The user requested the system to read the file." },
    { id: "valid-10", memory: "User is based in Beijing, UTC+8" },
  ];
  const backend = new Mem0FreeTextBackend(makeConfig(), logger, async () => makeMockProvider(items));
  const listed = await backend.list(scope);
  assert(!listed.some((r) => r.id === "noise-5"), "HEARTBEAT excluded");
  assert(!listed.some((r) => r.id === "noise-6"), "timestamp excluded");
  assert(!listed.some((r) => r.id === "noise-7"), "agent self-narration excluded");
  assert(listed.some((r) => r.id === "valid-10"), "valid memory retained");
});

// Summary
console.log();
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
