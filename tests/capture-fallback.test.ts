// ============================================================================
// Test: capture hook fallback — forwards user messages to candidateQueue
// when message_received didn't fire (e.g. CLI mode).
// Run with: npx tsx tests/capture-fallback.test.ts
// ============================================================================

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CandidateQueue } from "../candidate-queue.js";
import { OutboxWorker } from "../outbox.js";
import { CoreMemoryRepository } from "../core-repository.js";
import { CoreProposalQueue } from "../core-proposals.js";
import { LRUCache } from "../cache.js";
import { Metrics } from "../metrics.js";
import { createCaptureHook } from "../hooks/capture.js";
import { createRecallHook } from "../hooks/recall.js";
import { InboundMessageCache } from "../inbound-cache.js";
import { DEFAULT_CONFIG } from "../types.js";
import type { MemuPluginConfig, MemuMemoryRecord, MemoryScope } from "../types.js";
import type { FreeTextBackend, FreeTextBackendStatus } from "../backends/free-text/base.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function assertEqual<T>(a: T, b: T, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const DEBUG = process.env.E2E_DEBUG === "1";
const logger = {
  info: (msg: string) => { if (DEBUG) console.log("  [INFO]", msg); },
  warn: (msg: string) => { if (DEBUG) console.log("  [WARN]", msg); },
};

// ── InMemoryFreeTextBackend ──────────────────────────────────────────────────

class InMemoryFreeTextBackend implements FreeTextBackend {
  readonly provider = "in-memory-test";
  items: Array<{ text: string; scope: MemoryScope }> = [];

  async healthCheck(): Promise<FreeTextBackendStatus> {
    return { provider: this.provider, healthy: true };
  }
  async store(text: string, scope: MemoryScope): Promise<boolean> {
    this.items.push({ text, scope });
    return true;
  }
  async search(): Promise<MemuMemoryRecord[]> { return []; }
  async list(): Promise<MemuMemoryRecord[]> { return []; }
  async forget(): Promise<{ purged_categories: number; purged_items: number; purged_resources: number } | null> {
    return { purged_categories: 0, purged_items: 0, purged_resources: 0 };
  }
}

const syncStub = {
  registerAgent() {},
  scheduleSync() {},
  start() {},
  stop() {},
} as any;

const testScope: MemoryScope = {
  userId: "test_user",
  agentId: "main",
  sessionKey: "agent:main:test",
};

function buildTestConfig(tmpDir: string, overrides?: Partial<MemuPluginConfig>): MemuPluginConfig {
  return {
    ...DEFAULT_CONFIG,
    scope: {
      ...DEFAULT_CONFIG.scope,
      userId: testScope.userId,
      agentId: testScope.agentId,
    },
    capture: {
      ...DEFAULT_CONFIG.capture,
      enabled: true,
      candidateQueue: {
        enabled: true,
        intervalMs: 999_999,
        maxBatchSize: 50,
      },
    },
    core: {
      ...DEFAULT_CONFIG.core,
      enabled: true,
      persistPath: tmpDir,
      autoExtractProposals: true,
      humanReviewRequired: false,
    },
    outbox: {
      ...DEFAULT_CONFIG.outbox,
      enabled: true,
      persistPath: tmpDir,
      flushIntervalMs: 999_999,
    },
    ...overrides,
  };
}

function makeAgentEndEvent(userMessages: string[]) {
  return {
    messages: userMessages.map((text) => ({
      role: "user",
      content: text,
    })),
  };
}

const baseCtx = {
  channelId: "ch_test",
  accountId: "acc_1",
  agentId: "main",
  sessionKey: "agent:main:test",
  sessionId: "test-session-1",
};

// ── Capture Hook Fallback Tests ──────────────────────────────────────────────

console.log("\nCapture Hook Fallback Tests\n");

await test("1. Forwards last user message to candidateQueue when enabled", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cap-fb-1-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const proposalQueue = new CoreProposalQueue(tmpDir, 100, logger);
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);
    const metrics = new Metrics();

    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1, batchSize: 10, maxRetries: 3,
      persistPath: tmpDir, flushIntervalMs: 999_999,
    });

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, metrics, syncStub, candidateQueue,
    );

    await hook(
      makeAgentEndEvent(["我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务"]),
      baseCtx,
    );

    assertEqual(candidateQueue.enqueued, 1, "should have enqueued the last user message");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("2. Dedup — same message not double-enqueued via hash", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cap-fb-2-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const proposalQueue = new CoreProposalQueue(tmpDir, 100, logger);
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);
    const metrics = new Metrics();

    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1, batchSize: 10, maxRetries: 3,
      persistPath: tmpDir, flushIntervalMs: 999_999,
    });

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const msg = "我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务";

    // Simulate message_received hook enqueue first
    candidateQueue.enqueue(msg, testScope);
    assertEqual(candidateQueue.enqueued, 1, "message_received should enqueue 1");

    // Now capture hook fires with the same message
    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, metrics, syncStub, candidateQueue,
    );
    await hook(makeAgentEndEvent([msg]), baseCtx);

    // CandidateQueue hash-dedup should reject the duplicate
    assertEqual(candidateQueue.enqueued, 1, "duplicate should not be re-enqueued");
    assertEqual(candidateQueue.dropped, 1, "duplicate should be counted as dropped");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("3. Filters low-signal last message", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cap-fb-3-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const proposalQueue = new CoreProposalQueue(tmpDir, 100, logger);
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);
    const metrics = new Metrics();

    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1, batchSize: 10, maxRetries: 3,
      persistPath: tmpDir, flushIntervalMs: 999_999,
    });

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, metrics, syncStub, candidateQueue,
    );

    // Last message is "好的" (low-signal) — should not be enqueued
    await hook(
      makeAgentEndEvent([
        "我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务",
        "好的",
      ]),
      baseCtx,
    );

    assertEqual(candidateQueue.enqueued, 0, "low-signal last message should not be enqueued");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("4. Strips <relevant-memories> before capture via sanitizePromptQuery", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cap-fb-4-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const proposalQueue = new CoreProposalQueue(tmpDir, 100, logger);
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);
    const metrics = new Metrics();

    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1, batchSize: 10, maxRetries: 3,
      persistPath: tmpDir, flushIntervalMs: 999_999,
    });

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, metrics, syncStub, candidateQueue,
    );

    // Message with injected memory — sanitizePromptQuery strips injected blocks
    // leaving only the user text. If user text alone is too short, it's filtered.
    await hook(
      makeAgentEndEvent([
        "<relevant-memories>用户叫昊</relevant-memories>\n我的编辑器是 Neovim，日常都用它写代码和开发",
      ]),
      baseCtx,
    );

    // After stripping <relevant-memories>, the remaining text is
    // "我的编辑器是 Neovim，日常都用它写代码和开发" (≥24 chars)
    assertEqual(candidateQueue.enqueued, 1, "should enqueue after stripping injected blocks");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("5. Falls back to direct outbox path when candidateQueue disabled", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cap-fb-5-"));
  try {
    const config = buildTestConfig(tmpDir, {
      capture: {
        ...DEFAULT_CONFIG.capture,
        enabled: true,
        candidateQueue: { enabled: false, intervalMs: 999_999, maxBatchSize: 50 },
      },
    });
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const proposalQueue = new CoreProposalQueue(tmpDir, 100, logger);
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);
    const metrics = new Metrics();

    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1, batchSize: 10, maxRetries: 3,
      persistPath: tmpDir, flushIntervalMs: 999_999,
    });
    await outbox.loadFromDisk();

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, metrics, syncStub, candidateQueue,
    );

    await hook(
      makeAgentEndEvent(["我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务"]),
      baseCtx,
    );

    assertEqual(candidateQueue.enqueued, 0, "candidateQueue disabled — should not enqueue");
    assert(outbox.sent >= 1 || outbox.pending >= 1, "should have been sent to outbox directly");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("6. Works without candidateQueue parameter (backward compat)", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cap-fb-6-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const proposalQueue = new CoreProposalQueue(tmpDir, 100, logger);
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);
    const metrics = new Metrics();

    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1, batchSize: 10, maxRetries: 3,
      persistPath: tmpDir, flushIntervalMs: 999_999,
    });
    await outbox.loadFromDisk();

    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, metrics, syncStub,
    );

    await hook(
      makeAgentEndEvent(["删除操作的默认行为必须是使用 trash 命令，而不是直接删除文件"]),
      baseCtx,
    );

    assert(outbox.sent >= 1 || outbox.pending >= 1, "should fall back to outbox when no candidateQueue");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("7. Only captures LAST user message from multi-message history", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cap-fb-7-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const proposalQueue = new CoreProposalQueue(tmpDir, 100, logger);
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);
    const metrics = new Metrics();

    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1, batchSize: 10, maxRetries: 3,
      persistPath: tmpDir, flushIntervalMs: 999_999,
    });

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, metrics, syncStub, candidateQueue,
    );

    // Simulate session history: 3 user messages. Only the LAST should be captured.
    await hook(
      makeAgentEndEvent([
        "我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务",
        "我现在的职业是字节跳动资深后端架构师，深耕分布式系统",
        "我的人格倾向是 INTJ，偏好独立深度思考而非频繁沟通",
      ]),
      baseCtx,
    );

    // Only the last message should be enqueued (current turn)
    assertEqual(candidateQueue.enqueued, 1, "only the LAST user message should be enqueued");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("8. Skips assistant messages when finding last user message", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cap-fb-8-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const proposalQueue = new CoreProposalQueue(tmpDir, 100, logger);
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);
    const metrics = new Metrics();

    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1, batchSize: 10, maxRetries: 3,
      persistPath: tmpDir, flushIntervalMs: 999_999,
    });

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, metrics, syncStub, candidateQueue,
    );

    await hook(
      {
        messages: [
          { role: "user", content: "我在字节跳动做后端开发，主要用Go语言，负责核心服务" },
          { role: "assistant", content: "好的，我已经记住了。你在字节跳动做后端，用Go做推荐系统核心服务。" },
          { role: "user", content: "我现在的职业是字节跳动资深后端架构师，深耕分布式系统" },
        ],
      },
      baseCtx,
    );

    // Should capture only the last user message, skipping the assistant message
    assertEqual(candidateQueue.enqueued, 1, "should enqueue only the last user message");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Recall Hook Capture Side-Effect Tests ────────────────────────────────────

console.log("\nRecall Hook Capture Side-Effect Tests\n");

await test("9. Recall hook enqueues last user message to candidateQueue", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "recall-cap-9-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);
    const inbound = new InboundMessageCache(join(tmpDir, "inbound.json"));
    const metrics = new Metrics();

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const hook = createRecallHook(
      mockBackend, { resolveRuntimeScope: () => testScope },
      coreRepo, cache, inbound, config, logger, metrics, syncStub, candidateQueue,
    );

    await hook(
      {
        messages: [
          { role: "user", content: "我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务" },
        ],
      },
      baseCtx,
    );

    assert(candidateQueue.enqueued >= 1, `recall hook should enqueue user message, got enqueued=${candidateQueue.enqueued}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("10. Recall hook skips short messages (< minChars)", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "recall-cap-10-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);
    const inbound = new InboundMessageCache(join(tmpDir, "inbound.json"));
    const metrics = new Metrics();

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const hook = createRecallHook(
      mockBackend, { resolveRuntimeScope: () => testScope },
      coreRepo, cache, inbound, config, logger, metrics, syncStub, candidateQueue,
    );

    await hook(
      { messages: [{ role: "user", content: "我叫昊" }] },
      baseCtx,
    );

    assertEqual(candidateQueue.enqueued, 0, "short message should not be enqueued");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("11. Recall hook skips assistant messages", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "recall-cap-11-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);
    const inbound = new InboundMessageCache(join(tmpDir, "inbound.json"));
    const metrics = new Metrics();

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const hook = createRecallHook(
      mockBackend, { resolveRuntimeScope: () => testScope },
      coreRepo, cache, inbound, config, logger, metrics, syncStub, candidateQueue,
    );

    await hook(
      {
        messages: [
          { role: "assistant", content: "好的，我已经记住了你在字节跳动做后端开发，负责推荐系统的核心服务。" },
        ],
      },
      baseCtx,
    );

    assertEqual(candidateQueue.enqueued, 0, "assistant message should not be enqueued");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("12. Recall hook dedup — same message not enqueued twice", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "recall-cap-12-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);
    const inbound = new InboundMessageCache(join(tmpDir, "inbound.json"));
    const metrics = new Metrics();

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const msg = "我的主目标是成为一人公司创业者，借助 AI 完成职业转型";

    const hook = createRecallHook(
      mockBackend, { resolveRuntimeScope: () => testScope },
      coreRepo, cache, inbound, config, logger, metrics, syncStub, candidateQueue,
    );

    await hook({ messages: [{ role: "user", content: msg }] }, baseCtx);
    assertEqual(candidateQueue.enqueued, 1, "first call should enqueue");

    await hook({ messages: [{ role: "user", content: msg }] }, baseCtx);
    assertEqual(candidateQueue.enqueued, 1, "duplicate should not be re-enqueued");
    assertEqual(candidateQueue.dropped, 1, "duplicate should be counted as dropped");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log("");
const passed = results.filter((r) => r.passed).length;
const total = results.length;
console.log(`${passed}/${total} passed`);
if (passed < total) {
  console.log("\nFailures:");
  for (const r of results.filter((r) => !r.passed)) {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  }
  process.exit(1);
}
