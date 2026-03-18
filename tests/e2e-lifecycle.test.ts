// ============================================================================
// E2E Lifecycle Test: Message → Queue → Capture → Recall
// Exercises the full memory pipeline with real components, only FreeTextBackend mocked.
// Run with: npx tsx tests/e2e-lifecycle.test.ts
// ============================================================================

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InboundMessageCache } from "../inbound-cache.js";
import { CandidateQueue } from "../candidate-queue.js";
import { OutboxWorker } from "../outbox.js";
import { CoreMemoryRepository } from "../core-repository.js";
import { CoreProposalQueue, extractCoreProposal } from "../core-proposals.js";
import { LRUCache } from "../cache.js";
import { Metrics } from "../metrics.js";
import { createMessageReceivedHook } from "../hooks/message-received.js";
import { createCaptureHook } from "../hooks/capture.js";
import { createRecallHook } from "../hooks/recall.js";
import { DEFAULT_CONFIG } from "../types.js";
import type { MemuPluginConfig, MemuMemoryRecord, MemoryScope, ConversationMessage } from "../types.js";
import type { FreeTextBackend, FreeTextBackendStatus, FreeTextSearchOptions, FreeTextStoreOptions, FreeTextForgetOptions } from "../backends/free-text/base.js";

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

type StoredFreeText = { messages: ConversationMessage[]; scope: MemoryScope; metadata?: Record<string, unknown> };

// Helper to extract text from messages
function getTextFromMessages(messages: ConversationMessage[]): string {
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  return lastUser?.content ?? "";
}

class InMemoryFreeTextBackend implements FreeTextBackend {
  readonly provider = "in-memory-test";
  items: StoredFreeText[] = [];

  async healthCheck(): Promise<FreeTextBackendStatus> {
    return { provider: this.provider, healthy: true };
  }

  async store(messages: ConversationMessage[], scope: MemoryScope, options?: FreeTextStoreOptions): Promise<boolean> {
    this.items.push({ messages, scope, metadata: options?.metadata });
    return true;
  }

  async search(query: string, scope: MemoryScope, _options?: FreeTextSearchOptions): Promise<MemuMemoryRecord[]> {
    const q = query.toLowerCase();
    // Extract bigrams from query for CJK substring matching
    const queryBigrams = new Set<string>();
    for (let i = 0; i < q.length - 1; i++) {
      queryBigrams.add(q.slice(i, i + 2));
    }
    return this.items
      .filter((item) => item.scope.userId === scope.userId && item.scope.agentId === scope.agentId)
      .filter((item) => {
        const text = getTextFromMessages(item.messages).toLowerCase();
        // Direct substring match
        if (text.includes(q)) return true;
        // Token-based match (whitespace split)
        if (q.split(/\s+/).some((tok) => tok.length >= 2 && text.includes(tok))) return true;
        // Bigram overlap for CJK text
        if (queryBigrams.size > 0) {
          let hits = 0;
          for (const bg of queryBigrams) {
            if (text.includes(bg)) hits++;
          }
          return hits / queryBigrams.size >= 0.3;
        }
        return false;
      })
      .map((item, i) => ({
        id: `ft-${i}`,
        text: getTextFromMessages(item.messages),
        category: (item.metadata?.memory_kind as string) ?? "general",
        score: 0.8,
        source: "memu_item" as const,
        scope: item.scope,
        metadata: item.metadata,
      }));
  }

  async list(scope: MemoryScope, _options?: { limit?: number }): Promise<MemuMemoryRecord[]> {
    return this.items
      .filter((item) => item.scope.userId === scope.userId && item.scope.agentId === scope.agentId)
      .map((item, i) => ({
        id: `ft-${i}`,
        text: getTextFromMessages(item.messages),
        category: "general",
        source: "memu_item" as const,
        scope: item.scope,
      }));
  }

  async forget(_scope: MemoryScope, _options?: FreeTextForgetOptions): Promise<{ purged_categories: number; purged_items: number; purged_resources: number } | null> {
    return { purged_categories: 0, purged_items: 0, purged_resources: 0 };
  }
}

// ── Stub MarkdownSync ────────────────────────────────────────────────────────

const syncStub = {
  registerAgent(_agentId: string, _workspaceDir: string) {},
  scheduleSync() {},
  start() {},
  stop() {},
} as any;

// ── Shared test scope ────────────────────────────────────────────────────────

const testScope: MemoryScope = {
  userId: "test_user",
  agentId: "main",
  sessionKey: "agent:main:test",
};

// ── Config overrides ─────────────────────────────────────────────────────────

function buildTestConfig(tmpDir: string): MemuPluginConfig {
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
        intervalMs: 999_999, // manual drain only
        maxBatchSize: 50,
      },
    },
    core: {
      ...DEFAULT_CONFIG.core,
      enabled: true,
      persistPath: tmpDir,
      autoExtractProposals: true,
      humanReviewRequired: false,
      consolidation: {
        enabled: true,
        intervalMs: 0,
        similarityThreshold: 0.85,
      },
    },
    outbox: {
      ...DEFAULT_CONFIG.outbox,
      enabled: true,
      persistPath: tmpDir,
      flushIntervalMs: 999_999, // manual flush only
    },
    recall: {
      ...DEFAULT_CONFIG.recall,
      enabled: true,
    },
    sync: {
      ...DEFAULT_CONFIG.sync,
      enabled: false,
    },
  };
}

const baseCtx = {
  channelId: "ch_e2e",
  accountId: "acc_1",
  agentId: "main",
  sessionKey: "agent:main:test",
  sessionId: "e2e-session-1",
};

// ── Tests ────────────────────────────────────────────────────────────────────

console.log("\nE2E Lifecycle Tests\n");

// Each test gets its own tmpDir and fresh components.

await test("1. Message → InboundCache", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "e2e-1-"));
  try {
    const inbound = new InboundMessageCache(join(tmpDir, "inbound.json"));

    const hook = createMessageReceivedHook(inbound, logger);
    await hook({ from: "user1", content: "我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务" }, baseCtx);

    const cached = await inbound.getBySender("ch_e2e", "user1");
    assert(!!cached, "inbound cache should return the message");
    assert(cached!.includes("字节跳动"), "cached text should contain original content");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("2. Capture hook → CandidateQueue filtering", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "e2e-2-"));
  try {
    const config = buildTestConfig(tmpDir);
    const inbound = new InboundMessageCache(join(tmpDir, "inbound.json"));
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const proposalQueue = new CoreProposalQueue(tmpDir, 100, logger);
    const mockBackend = new InMemoryFreeTextBackend();
    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1, batchSize: 10, maxRetries: 3,
      persistPath: tmpDir, flushIntervalMs: 999_999,
    });
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999,
      maxBatchSize: 50,
      persistPath: tmpDir,
    });

    const testMetrics = new Metrics();
    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, testMetrics, syncStub, candidateQueue, inbound,
    );

    // Valid message should be captured (via event.messages since no event.prompt)
    await hook(
      { messages: [{ role: "user", content: "我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务" }] },
      baseCtx,
    );
    assertEqual(testMetrics.captureCaptured, 1, "valid message should be captured");

    // Low-signal message should be filtered (not captured)
    await hook(
      { messages: [{ role: "user", content: "好的" }] },
      baseCtx,
    );
    assertEqual(testMetrics.captureCaptured, 1, "low-signal '好的' should not be captured");
    assertEqual(testMetrics.captureFiltered, 1, "low-signal '好的' should be filtered");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("2b. Capture hook skips unsuccessful agent_end", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "e2e-2b-"));
  try {
    const config = buildTestConfig(tmpDir);
    const inbound = new InboundMessageCache(join(tmpDir, "inbound.json"));
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const proposalQueue = new CoreProposalQueue(tmpDir, 100, logger);
    const mockBackend = new InMemoryFreeTextBackend();
    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1, batchSize: 10, maxRetries: 3,
      persistPath: tmpDir, flushIntervalMs: 999_999,
    });
    const cache = new LRUCache<MemuMemoryRecord[]>(100, 60_000);

    const candidateQueue = new CandidateQueue(async () => {}, logger, {
      intervalMs: 999_999,
      maxBatchSize: 50,
      persistPath: tmpDir,
    });

    const testMetrics = new Metrics();
    const hook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, testMetrics, syncStub, candidateQueue, inbound,
    );

    await hook(
      { success: false, messages: [{ role: "user", content: "我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务" }] },
      baseCtx,
    );

    assertEqual(testMetrics.captureCaptured, 0, "failed agent_end should not be captured");
    assertEqual(candidateQueue.enqueued, 0, "failed agent_end should not enqueue candidate");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("3. CandidateQueue batch → Outbox", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "e2e-3-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1,
      batchSize: 10,
      maxRetries: 3,
      persistPath: tmpDir,
      flushIntervalMs: 999_999,
    });
    await outbox.loadFromDisk();

    let processorCalled = false;
    const candidateQueue = new CandidateQueue(
      async (batch) => {
        processorCalled = true;
        for (const item of batch) {
          outbox.enqueue(item.messages, item.scope, { memory_kind: "general", quality: "durable" });
        }
      },
      logger,
      { intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir },
    );

    candidateQueue.enqueue([{ role: "user", content: "我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务" }], testScope);
    assert(candidateQueue.pending === 1, "should have 1 pending");

    await candidateQueue.drain(3_000);

    assert(processorCalled, "processor should have been called");
    assertEqual(candidateQueue.pending, 0, "queue should be drained");
    // OutboxWorker auto-flushes on enqueue, so the item may already be sent.
    // Verify it was processed (sent or still pending).
    assert(outbox.sent >= 1 || outbox.pending >= 1, "outbox should have received and/or sent item");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("4. Core regex extraction via CandidateQueue (我叫小明)", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "e2e-4-"));
  try {
    const config = buildTestConfig(tmpDir);
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);

    // CandidateQueue with core extraction processor
    const candidateQueue = new CandidateQueue(
      async (batch) => {
        for (const item of batch) {
          if (config.core.enabled && config.core.autoExtractProposals) {
            const itemText = getTextFromMessages(item.messages);
            const draft = extractCoreProposal(itemText, item.scope);
            if (draft) {
              await coreRepo.upsert(item.scope, {
                key: draft.key,
                value: draft.value,
                source: "capture-batch",
                metadata: { reason: draft.reason },
              });
            }
          }
        }
      },
      logger,
      { intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir },
    );

    // Enqueue message with identity pattern
    const msg = "我叫小明，是一个在字节跳动工作的前端工程师，主要做React开发";
    candidateQueue.enqueue([{ role: "user", content: msg }], testScope);

    // Drain to trigger processor
    await candidateQueue.drain(3_000);

    const coreItems = await coreRepo.list(testScope);
    assert(coreItems.length >= 1, `core should have at least 1 item, got ${coreItems.length}`);
    const nameItem = coreItems.find((item) => item.key.includes("identity.name"));
    assert(!!nameItem, "should have identity.name key");
    assert(nameItem!.value.includes("小明"), "value should contain 小明");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("5. Outbox flush → FreeTextBackend", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "e2e-5-"));
  try {
    const mockBackend = new InMemoryFreeTextBackend();
    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1,
      batchSize: 10,
      maxRetries: 3,
      persistPath: tmpDir,
      flushIntervalMs: 999_999,
    });
    await outbox.loadFromDisk();

    outbox.enqueue([{ role: "user", content: "用户偏好使用深色主题进行编程开发工作" }], testScope, {
      source: "memory-mem0",
      memory_kind: "preference",
      quality: "durable",
    });

    // Wait for the immediate flush triggered by enqueue
    await new Promise((r) => setTimeout(r, 200));
    // Also explicitly drain
    await outbox.drain(3_000);

    assertEqual(outbox.pending, 0, "outbox should be empty after drain");
    assert(mockBackend.items.length >= 1, `backend should have at least 1 item, got ${mockBackend.items.length}`);
    assert(getTextFromMessages(mockBackend.items[0].messages).includes("深色主题"), "stored text should match");
    assertEqual(mockBackend.items[0].scope.userId, testScope.userId, "scope userId should match");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("6. Core consolidation (dedup near-duplicate values)", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "e2e-6-"));
  try {
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, 240);

    await coreRepo.upsert(testScope, {
      category: "identity",
      key: "identity.name.v1",
      value: "我叫小明",
      source: "test",
    });
    await coreRepo.upsert(testScope, {
      category: "identity",
      key: "identity.name.v2",
      value: "我叫小明呀",
      source: "test",
    });

    const before = await coreRepo.list(testScope);
    assert(before.length === 2, `should have 2 items before consolidation, got ${before.length}`);

    const result = await coreRepo.consolidate(testScope, { similarityThreshold: 0.7 });
    assert(result.merged >= 1, `should merge at least 1, got merged=${result.merged}`);

    const after = await coreRepo.list(testScope);
    assert(after.length < before.length, `should have fewer items after consolidation (before=${before.length}, after=${after.length})`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("7. Recall: core injection", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "e2e-7-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const cache = new LRUCache<MemuMemoryRecord[]>(50, 60_000);
    const inbound = new InboundMessageCache(join(tmpDir, "inbound.json"));
    const metrics = new Metrics();
    const scopeResolver = {
      resolveRuntimeScope: () => testScope,
    };

    // Pre-populate core memory (value must be >= 3 chars to pass shouldStoreCoreMemory)
    await coreRepo.upsert(testScope, {
      category: "identity",
      key: "identity.name",
      value: "用户名字是小明",
      source: "test",
    });

    // Verify upsert succeeded
    const coreItems = await coreRepo.list(testScope);
    assert(coreItems.length >= 1, `core should have items after upsert, got ${coreItems.length}`);

    const recallHook = createRecallHook(
      mockBackend,
      scopeResolver,
      coreRepo,
      cache,
      inbound,
      config,
      logger,
      metrics,
      syncStub,
    );

    const result = await recallHook(
      { messages: [{ role: "user", content: "我叫什么名字" }] },
      { ...baseCtx, sessionId: "e2e-7-session" },
    );

    assert(!!result, "recall should return a result");
    assert(typeof (result as any).prependContext === "string", "result should have prependContext");
    assert((result as any).prependContext.includes("小明"), `prependContext should include '小明', got: ${(result as any).prependContext.slice(0, 200)}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("8. Recall: free-text injection", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "e2e-8-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const cache = new LRUCache<MemuMemoryRecord[]>(50, 60_000);
    const inbound = new InboundMessageCache(join(tmpDir, "inbound.json"));
    const metrics = new Metrics();
    const scopeResolver = {
      resolveRuntimeScope: () => testScope,
    };

    // Pre-populate free-text backend
    await mockBackend.store([{ role: "user", content: "用户偏好深色主题和Vim键绑定进行代码编辑" }], testScope, {
      memory_kind: "preference",
    });

    const recallHook = createRecallHook(
      mockBackend,
      scopeResolver,
      coreRepo,
      cache,
      inbound,
      config,
      logger,
      metrics,
      syncStub,
    );

    // Query that overlaps with stored text tokens for substring match
    const result = await recallHook(
      { messages: [{ role: "user", content: "深色主题偏好是什么" }] },
      { ...baseCtx, sessionId: "e2e-8-session" },
    );

    assert(!!result, "recall should return a result");
    const ctx = (result as any).prependContext as string;
    assert(ctx.includes("深色主题"), `prependContext should include '深色主题', got: ${ctx.slice(0, 300)}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("9. Recall: session dedup", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "e2e-9-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const cache = new LRUCache<MemuMemoryRecord[]>(50, 60_000);
    const inbound = new InboundMessageCache(join(tmpDir, "inbound.json"));
    const metrics = new Metrics();
    const scopeResolver = {
      resolveRuntimeScope: () => testScope,
    };

    await coreRepo.upsert(testScope, {
      category: "identity",
      key: "identity.name",
      value: "用户名字是小明",
      source: "test",
    });

    const recallHook = createRecallHook(
      mockBackend,
      scopeResolver,
      coreRepo,
      cache,
      inbound,
      config,
      logger,
      metrics,
      syncStub,
    );

    const messages = [{ role: "user", content: "我叫什么名字" }];
    const dedupCtx = { ...baseCtx, sessionId: "e2e-9-session" };

    // First call should return context
    const result1 = await recallHook({ messages }, dedupCtx);
    assert(!!result1, "first recall should return context");

    // Second call with same query within 30s window should be deduped
    const result2 = await recallHook({ messages }, dedupCtx);
    assert(!result2, `second recall within dedup window should return undefined, got: ${JSON.stringify(result2)?.slice(0, 100)}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await test("10. Full round-trip: message → queue → capture → recall", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "e2e-10-"));
  try {
    const config = buildTestConfig(tmpDir);
    const mockBackend = new InMemoryFreeTextBackend();
    const coreRepo = new CoreMemoryRepository(tmpDir, logger, config.core.maxItemChars);
    const inbound = new InboundMessageCache(join(tmpDir, "inbound.json"));
    const cache = new LRUCache<MemuMemoryRecord[]>(50, 60_000);
    const metrics = new Metrics();
    const scopeResolver = {
      resolveRuntimeScope: () => testScope,
    };

    const outbox = new OutboxWorker(mockBackend, logger, {
      concurrency: 1,
      batchSize: 10,
      maxRetries: 3,
      persistPath: tmpDir,
      flushIntervalMs: 999_999,
    });
    await outbox.loadFromDisk();

    const candidateQueue = new CandidateQueue(
      async (batch) => {
        for (const item of batch) {
          outbox.enqueue(item.messages, item.scope, {
            source: "memory-mem0",
            memory_kind: "general",
            quality: "durable",
          });
          // Also attempt core extraction
          if (config.core.enabled && config.core.autoExtractProposals) {
            const itemText = getTextFromMessages(item.messages);
            const draft = extractCoreProposal(itemText, item.scope);
            if (draft) {
              await coreRepo.upsert(item.scope, {
                key: draft.key,
                value: draft.value,
                source: "capture-batch",
                metadata: { reason: draft.reason },
              });
            }
          }
        }
      },
      logger,
      { intervalMs: 999_999, maxBatchSize: 50, persistPath: tmpDir },
    );

    const messageHook = createMessageReceivedHook(inbound, logger);
    const proposalQueue = new CoreProposalQueue(tmpDir, 100, logger);
    const captureHook = createCaptureHook(
      outbox, coreRepo, proposalQueue, cache, config, logger, metrics, syncStub, candidateQueue, inbound,
    );
    const recallHook = createRecallHook(
      mockBackend,
      scopeResolver,
      coreRepo,
      cache,
      inbound,
      config,
      logger,
      metrics,
      syncStub,
    );

    // Step 1: Send a message with identity info (cache it first)
    const userMessage = "我叫小明，是一个在字节跳动工作的前端工程师，主要做React开发";
    await messageHook({ from: "user1", content: userMessage }, baseCtx);

    // Step 1b: Capture hook processes the message (simulates agent_end)
    await captureHook(
      { messages: [{ role: "user", content: userMessage }] },
      baseCtx,
    );

    // Step 2: Drain candidate queue → outbox
    await candidateQueue.drain(3_000);

    // Step 3: Flush outbox → free-text backend
    await outbox.drain(3_000);

    // Verify: free-text backend received the memory
    assert(mockBackend.items.length >= 1, `free-text backend should have items, got ${mockBackend.items.length}`);

    // Verify: core memory was extracted (via CandidateQueue batch processor)
    const coreItems = await coreRepo.list(testScope);
    assert(coreItems.length >= 1, `core repo should have items, got ${coreItems.length}`);

    // Step 4: Recall — use a fresh session context to avoid dedup
    const recallCtx = { ...baseCtx, sessionId: "e2e-session-recall" };
    const result = await recallHook(
      { messages: [{ role: "user", content: "用户的名字是什么" }] },
      recallCtx,
    );

    assert(!!result, "recall should return context");
    const prependContext = (result as any).prependContext as string;
    assert(prependContext.includes("小明"), `recall should include '小明' from core memory, got: ${prependContext.slice(0, 300)}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

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
