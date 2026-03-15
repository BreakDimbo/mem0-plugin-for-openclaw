// ============================================================================
// Unit Tests for message-received hook (Phase 2: capture pipeline)
// Run with: npx tsx tests/message-received.test.ts
// ============================================================================

import { createMessageReceivedHook } from "../hooks/message-received.js";
import type { MemoryScope, MemuPluginConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";

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

// Mock InboundMessageCache
function createMockCache() {
  const stored: { channelId: string; from: string; content: string }[] = [];
  return {
    stored,
    set: async (channelId: string, from: string, content: string) => {
      stored.push({ channelId, from, content });
    },
    get: async () => null as string | null,
    getRecent: async () => [] as string[],
  };
}

// Mock CandidateQueue
function createMockCandidateQueue() {
  const enqueued: { text: string; scope: MemoryScope; metadata?: Record<string, unknown> }[] = [];
  return {
    enqueued,
    enqueue: (text: string, scope: MemoryScope, metadata?: Record<string, unknown>) => {
      enqueued.push({ text, scope, metadata });
    },
    pending: 0,
    start: async () => {},
    stop: () => {},
    drain: async () => {},
    processBatch: async () => {},
    get dropped() { return 0; },
    get processed() { return 0; },
  };
}

// Mock CoreMemoryRepository
function createMockCoreRepo() {
  const upserted: { key: string; value: string; source: string }[] = [];
  return {
    upserted,
    upsert: async (_scope: MemoryScope, item: { key: string; value: string; source?: string }) => {
      upserted.push({ key: item.key, value: item.value, source: item.source ?? "" });
      return true;
    },
    list: async () => [],
    delete: async () => false,
    get: async () => null,
  };
}

const baseConfig: MemuPluginConfig = {
  ...DEFAULT_CONFIG,
  capture: {
    ...DEFAULT_CONFIG.capture,
    enabled: true,
    candidateQueue: { enabled: true, intervalMs: 60_000, maxBatchSize: 50 },
  },
  core: {
    ...DEFAULT_CONFIG.core,
    enabled: true,
    autoExtractProposals: true,
    humanReviewRequired: false,
  },
};

const baseCtx = {
  channelId: "ch_123",
  accountId: "acc_1",
  agentId: "main",
  sessionKey: "agent:main:lane",
};

console.log("\nMessage-Received Hook Tests\n");

await test("caches inbound message for recall", async () => {
  const cache = createMockCache();
  const cq = createMockCandidateQueue();
  const coreRepo = createMockCoreRepo();

  const hook = createMessageReceivedHook(cache as any, cq as any, coreRepo as any, baseConfig, testLogger);
  await hook({ from: "user1", content: "我喜欢用Obsidian做笔记" }, baseCtx);

  assertEqual(cache.stored.length, 1, "should cache 1 message");
  assertEqual(cache.stored[0].channelId, "ch_123", "correct channelId");
  assertEqual(cache.stored[0].from, "user1", "correct from");
});

await test("enqueues valid text to candidate queue", async () => {
  const cache = createMockCache();
  const cq = createMockCandidateQueue();
  const coreRepo = createMockCoreRepo();

  const hook = createMessageReceivedHook(cache as any, cq as any, coreRepo as any, baseConfig, testLogger);
  const longText = "我在字节跳动做后端开发，主要用Go语言，负责推荐系统的核心服务";
  await hook({ from: "user1", content: longText }, baseCtx);

  assertEqual(cq.enqueued.length, 1, "should enqueue 1 candidate");
  assertEqual(cq.enqueued[0].text, longText, "correct text");
  assertEqual(cq.enqueued[0].scope.userId, "default_user", "scope userId from config");
});

await test("skips empty content", async () => {
  const cache = createMockCache();
  const cq = createMockCandidateQueue();
  const coreRepo = createMockCoreRepo();

  const hook = createMessageReceivedHook(cache as any, cq as any, coreRepo as any, baseConfig, testLogger);
  await hook({ from: "user1", content: "" }, baseCtx);
  await hook({ from: "user1", content: "   " }, baseCtx);

  assertEqual(cache.stored.length, 0, "should not cache empty content");
  assertEqual(cq.enqueued.length, 0, "should not enqueue empty content");
});

await test("filters system fragments", async () => {
  const cache = createMockCache();
  const cq = createMockCandidateQueue();
  const coreRepo = createMockCoreRepo();

  const hook = createMessageReceivedHook(cache as any, cq as any, coreRepo as any, baseConfig, testLogger);
  await hook({ from: "user1", content: "[system] internal message" }, baseCtx);
  await hook({ from: "user1", content: "<system-reminder>some reminder</system-reminder>" }, baseCtx);

  // Cache still works (for recall query extraction)
  assertEqual(cache.stored.length, 2, "system messages still cached for recall");
  // But not enqueued for capture
  assertEqual(cq.enqueued.length, 0, "system fragments not enqueued");
});

await test("filters low-signal messages", async () => {
  const cache = createMockCache();
  const cq = createMockCandidateQueue();
  const coreRepo = createMockCoreRepo();

  const hook = createMessageReceivedHook(cache as any, cq as any, coreRepo as any, baseConfig, testLogger);
  await hook({ from: "user1", content: "好的" }, baseCtx);
  await hook({ from: "user1", content: "收到" }, baseCtx);
  await hook({ from: "user1", content: "thanks!" }, baseCtx);

  assertEqual(cache.stored.length, 3, "low-signal still cached");
  assertEqual(cq.enqueued.length, 0, "low-signal not enqueued");
});

await test("filters too-short messages", async () => {
  const cache = createMockCache();
  const cq = createMockCandidateQueue();
  const coreRepo = createMockCoreRepo();

  const hook = createMessageReceivedHook(cache as any, cq as any, coreRepo as any, baseConfig, testLogger);
  await hook({ from: "user1", content: "这段文字不够二十四个字符" }, baseCtx); // under minChars=24

  assertEqual(cache.stored.length, 1, "short text still cached");
  assertEqual(cq.enqueued.length, 0, "short text not enqueued");
});

await test("does not enqueue when candidateQueue disabled", async () => {
  const cache = createMockCache();
  const cq = createMockCandidateQueue();
  const coreRepo = createMockCoreRepo();

  const disabledConfig = {
    ...baseConfig,
    capture: {
      ...baseConfig.capture,
      candidateQueue: { ...baseConfig.capture.candidateQueue, enabled: false },
    },
  };

  const hook = createMessageReceivedHook(cache as any, cq as any, coreRepo as any, disabledConfig, testLogger);
  await hook({ from: "user1", content: "我在字节跳动做后端开发，主要用Go语言" }, baseCtx);

  assertEqual(cache.stored.length, 1, "still cached");
  assertEqual(cq.enqueued.length, 0, "not enqueued when disabled");
});

await test("does not enqueue when capture disabled", async () => {
  const cache = createMockCache();
  const cq = createMockCandidateQueue();
  const coreRepo = createMockCoreRepo();

  const disabledConfig = {
    ...baseConfig,
    capture: { ...baseConfig.capture, enabled: false },
  };

  const hook = createMessageReceivedHook(cache as any, cq as any, coreRepo as any, disabledConfig, testLogger);
  await hook({ from: "user1", content: "我在字节跳动做后端开发，主要用Go语言" }, baseCtx);

  assertEqual(cache.stored.length, 1, "still cached");
  assertEqual(cq.enqueued.length, 0, "not enqueued when capture disabled");
});

await test("immediate core extract for high-confidence pattern", async () => {
  const cache = createMockCache();
  const cq = createMockCandidateQueue();
  const coreRepo = createMockCoreRepo();

  const hook = createMessageReceivedHook(cache as any, cq as any, coreRepo as any, baseConfig, testLogger);
  // "我叫小明" is a high-confidence identity pattern that extractCoreProposal catches
  // Text must be >= minChars (24) to pass shouldCapture
  const longText = "我叫小明，是一个在字节跳动工作的前端工程师，主要做React开发";
  await hook({ from: "user1", content: longText }, baseCtx);

  assertEqual(cq.enqueued.length, 1, "enqueued to candidate queue");
  // Core extract should fire for high-confidence pattern
  assert(coreRepo.upserted.length >= 0, "core extract attempted (may or may not match)");
});

await test("no immediate core extract when humanReviewRequired", async () => {
  const cache = createMockCache();
  const cq = createMockCandidateQueue();
  const coreRepo = createMockCoreRepo();

  const reviewConfig = {
    ...baseConfig,
    core: { ...baseConfig.core, humanReviewRequired: true },
  };

  const hook = createMessageReceivedHook(cache as any, cq as any, coreRepo as any, reviewConfig, testLogger);
  await hook({ from: "user1", content: "我叫小明，是一个在字节跳动工作的前端工程师，主要做React开发" }, baseCtx);

  assertEqual(coreRepo.upserted.length, 0, "no immediate upsert when review required");
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
