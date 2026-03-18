// ============================================================================
// Test: capture hook behavior and fallback paths.
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
import { InboundMessageCache } from "../inbound-cache.js";
import { DEFAULT_CONFIG } from "../types.js";
import type { MemuPluginConfig, MemuMemoryRecord, MemoryScope, ConversationMessage } from "../types.js";
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
  items: Array<{ messages: ConversationMessage[]; scope: MemoryScope }> = [];

  async healthCheck(): Promise<FreeTextBackendStatus> {
    return { provider: this.provider, healthy: true };
  }
  async store(messages: ConversationMessage[], scope: MemoryScope): Promise<boolean> {
    this.items.push({ messages, scope });
    return true;
  }
  async search(): Promise<MemuMemoryRecord[]> { return []; }
  async list(): Promise<MemuMemoryRecord[]> { return []; }
  async forget(): Promise<{ purged_categories: number; purged_items: number; purged_resources: number } | null> {
    return { purged_categories: 0, purged_items: 0, purged_resources: 0 };
  }
}

class InspectableCandidateQueue extends CandidateQueue {
  inspectMessages(index: number): ConversationMessage[] {
    return (this as any).queue[index]?.messages ?? [];
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

    const candidateQueue = new InspectableCandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, metrics, syncStub, candidateQueue,
    );

    await hook(
      makeAgentEndEvent(["我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务"]),
      baseCtx,
    );

    assertEqual(candidateQueue.enqueued, 1, "should enqueue one conversation window");
    assertEqual(candidateQueue.inspectMessages(0).length, 1, "single user turn should produce one captured message");
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

    const candidateQueue = new InspectableCandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const msgText = "我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务";

    // Simulate message_received hook enqueue first (wrap in messages array)
    candidateQueue.enqueue([{ role: "user", content: msgText }], testScope);
    assertEqual(candidateQueue.enqueued, 1, "message_received should enqueue 1");

    // Now capture hook fires with the same message
    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, metrics, syncStub, candidateQueue,
    );
    await hook(makeAgentEndEvent([msgText]), baseCtx);

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

    const candidateQueue = new InspectableCandidateQueue(async () => {}, logger, {
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

    const candidateQueue = new InspectableCandidateQueue(async () => {}, logger, {
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

    const candidateQueue = new InspectableCandidateQueue(async () => {}, logger, {
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

await test("7. Captures recent conversation window from multi-message history", async () => {
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

    const candidateQueue = new InspectableCandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, metrics, syncStub, candidateQueue,
    );

    // Simulate session history: 3 user turns. The recent conversation window should be captured.
    await hook(
      {
        messages: [
          { role: "user", content: "我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务", sender_id: "user-window" },
          { role: "assistant", content: "好的，我已经记录你的当前工作背景。" },
          { role: "user", content: "我现在的职业是字节跳动资深后端架构师，深耕分布式系统", sender_id: "user-window" },
          { role: "assistant", content: "明白了，我会按这个背景继续协助你。" },
          { role: "user", content: "我的人格倾向是 INTJ，偏好独立深度思考而非频繁沟通", sender_id: "user-window" },
        ],
      },
      baseCtx,
    );

    assertEqual(candidateQueue.enqueued, 1, "conversation should be enqueued once");
    assertEqual(candidateQueue.inspectMessages(0).length, 5, "recent turn window should keep all recent messages");
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

    const candidateQueue = new InspectableCandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, metrics, syncStub, candidateQueue,
    );

    await hook(
      {
        messages: [
          { role: "user", content: "我在字节跳动做后端开发，主要用Go语言，负责核心服务", sender_id: "user-last" },
          { role: "assistant", content: "好的，我已经记住了。你在字节跳动做后端，用Go做推荐系统核心服务。" },
          { role: "user", content: "我现在的职业是字节跳动资深后端架构师，深耕分布式系统", sender_id: "user-last" },
        ],
      },
      baseCtx,
    );

    assertEqual(candidateQueue.enqueued, 1, "should enqueue one conversation window");
    const capturedMessages = candidateQueue.inspectMessages(0);
    const lastCaptured = capturedMessages[capturedMessages.length - 1]?.content;
    assertEqual(lastCaptured, "我现在的职业是字节跳动资深后端架构师，深耕分布式系统", "last captured message should be latest user turn");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("9. Failed agent_end does not capture", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "cap-fb-9-"));
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
      { success: false, messages: [{ role: "user", content: "我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务" }] },
      baseCtx,
    );

    assertEqual(candidateQueue.enqueued, 0, "failed agent_end should not enqueue capture");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("10. Recall hook no longer enqueues capture side-effects", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "recall-cap-10-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const inbound = new InboundMessageCache(join(tmpDir, "inbound.json"));
    const metrics = new Metrics();

    const uniqueMessage = "我长期负责字节跳动推荐系统的多语言后端架构设计与稳定性治理";
    await inbound.set(baseCtx.channelId, "user-recall", uniqueMessage);
    await inbound.setClassification(baseCtx.channelId, "user-recall", {
      tier: "MEDIUM",
      queryType: "factual",
      targetCategories: [],
      captureHint: "full",
    });

    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1, batchSize: 10, maxRetries: 3,
      persistPath: tmpDir, flushIntervalMs: 999_999,
    });
    await outbox.loadFromDisk();

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir,
    });

    const hook = createCaptureHook(
      outbox,
      new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars),
      new CoreProposalQueue(tmpDir, 100, logger),
      new LRUCache<MemuMemoryRecord[]>(100, 60_000),
      {
        ...config,
        capture: {
          ...config.capture,
          candidateQueue: { enabled: false, intervalMs: 999_999, maxBatchSize: 50 },
        },
      },
      logger,
      metrics,
      syncStub,
      candidateQueue,
      inbound,
    );

    await hook(
      {
        messages: [{ role: "user", content: uniqueMessage, sender_id: "user-recall" }],
      },
      baseCtx,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    assertEqual(candidateQueue.enqueued, 0, "direct outbox mode should not enqueue candidateQueue");
    assert(outbox.sent >= 1 || outbox.pending >= 1, "capture should still proceed without recall-side enqueue");
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
