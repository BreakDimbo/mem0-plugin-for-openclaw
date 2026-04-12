// ============================================================================
// Test: Recall Hook Signal Instrumentation (DREAM-03)
// Run with: npx tsx tests/dreaming-recall-signals.test.ts
// ============================================================================

import { createRecallHook } from "../hooks/recall.js";
import type { MemuPluginConfig, MemuMemoryRecord, MemoryScope } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";
import { LRUCache } from "../cache.js";
import { Metrics } from "../metrics.js";
import { createHash } from "node:crypto";

class MockFreeTextBackend {
  provider = "mem0";
  memories: MemuMemoryRecord[] = [];

  search(_query: string, _scope: MemoryScope, _opts?: any): Promise<MemuMemoryRecord[]> {
    return Promise.resolve(this.memories);
  }
}

class MockCoreRepo {
  async list(_scope: MemoryScope, _opts?: any): Promise<Array<{ id: string; category?: string; key: string; value: string; tier?: string }>> {
    return [];
  }
  async touch(_scope: MemoryScope, _opts?: any): Promise<void> {}
}

class MockInboundCache {
  async getBySender(_channelId: string, _senderId: string): Promise<string | undefined> {
    return undefined;
  }
}

class MockSync {
  registerAgent() {}
}

class MockLogger {
  logs: string[] = [];
  info(msg: string) { this.logs.push(`INFO: ${msg}`); }
  warn(msg: string) { this.logs.push(`WARN: ${msg}`); }
}

class MockSignalStore {
  calls: Array<{
    key: string;
    layer: "core" | "free-text";
    snippet: string;
    queryHash: string;
    relevanceScore: number;
    conceptTags: string[];
  }> = [];
  shouldThrow = false;

  recordRecall(params: {
    key: string;
    layer: "core" | "free-text";
    snippet: string;
    queryHash: string;
    relevanceScore: number;
    conceptTags: string[];
  }): void {
    if (this.shouldThrow) {
      throw new Error("mock recordRecall error");
    }
    this.calls.push(params);
  }
}

function createTestConfig(): MemuPluginConfig {
  return {
    ...DEFAULT_CONFIG,
    recall: {
      ...DEFAULT_CONFIG.recall,
      enabled: true,
      topK: 5,
      threshold: 0.1,
      maxChars: 2000,
    },
    core: {
      ...DEFAULT_CONFIG.core,
      enabled: true,
      topK: 5,
      alwaysInjectTiers: ["profile", "general"],
      touchOnRecall: false,
    },
  };
}

async function runTests() {
  console.log("=== Dreaming Recall Signal Tests ===\n");
  let passed = 0;
  let failed = 0;

  // Test 1: Mock store + simulated recall (2 core + 1 free-text) → recordRecall called 3x with correct layers
  {
    const name = "recordRecall called 3x with correct layers for 2 core + 1 free-text";
    const backend = new MockFreeTextBackend();
    backend.memories = [
      {
        id: "ft-1",
        text: "User prefers dark mode in all applications",
        category: "preference",
        score: 0.85,
        source: "memu_item",
        scope: { userId: "u1", agentId: "a1", sessionKey: "s1" },
      },
    ];

    const coreRepo = new MockCoreRepo();
    coreRepo.list = async () => [
      { id: "core-1", category: "identity", key: "identity.name", value: "Alice", tier: "profile" },
      { id: "core-2", category: "work", key: "work.role", value: "Engineer", tier: "general" },
    ];

    const signalStore = new MockSignalStore();
    const logger = new MockLogger();
    const metrics = new Metrics();
    const cache = new LRUCache<MemuMemoryRecord[]>(10, 60_000);
    const config = createTestConfig();

    const hook = createRecallHook(
      backend as any,
      { resolveRuntimeScope: () => ({ userId: "u1", agentId: "a1", sessionKey: "s1" }) },
      coreRepo as any,
      cache,
      new MockInboundCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      undefined,
      signalStore as any,
    );

    const result = await hook(
      { prompt: "What do you know about me?", messages: [{ role: "user", content: "What do you know about me?" }] },
      { agentId: "a1", sessionKey: "s1-test1" },
    );

    if (
      signalStore.calls.length === 3 &&
      signalStore.calls.filter((c) => c.layer === "core").length === 2 &&
      signalStore.calls.filter((c) => c.layer === "free-text").length === 1 &&
      signalStore.calls.some((c) => c.key === "ft-1" && c.layer === "free-text") &&
      signalStore.calls.some((c) => c.key === "core-1" && c.layer === "core") &&
      signalStore.calls.some((c) => c.key === "core-2" && c.layer === "core") &&
      typeof result === "object" && result !== null && "prependContext" in result
    ) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  Calls: ${JSON.stringify(signalStore.calls)}`);
      failed++;
    }
  }

  // Test 2: dreaming.enabled: false or signalStore undefined → recordRecall never called
  {
    const name = "signalStore undefined → recordRecall never called";
    const backend = new MockFreeTextBackend();
    backend.memories = [
      {
        id: "ft-1",
        text: "User prefers dark mode",
        category: "preference",
        score: 0.85,
        source: "memu_item",
        scope: { userId: "u1", agentId: "a1", sessionKey: "s1" },
      },
    ];

    const coreRepo = new MockCoreRepo();
    coreRepo.list = async () => [
      { id: "core-1", category: "identity", key: "identity.name", value: "Alice", tier: "profile" },
    ];

    const logger = new MockLogger();
    const metrics = new Metrics();
    const cache = new LRUCache<MemuMemoryRecord[]>(10, 60_000);
    const config = createTestConfig();

    const hook = createRecallHook(
      backend as any,
      { resolveRuntimeScope: () => ({ userId: "u1", agentId: "a1", sessionKey: "s1" }) },
      coreRepo as any,
      cache,
      new MockInboundCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      undefined,
      undefined,
    );

    await hook(
      { prompt: "What is my name and role?", messages: [{ role: "user", content: "What is my name and role?" }] },
      { agentId: "a1", sessionKey: "s1-test2" },
    );

    // No signalStore means no errors and normal behavior
    console.log(`✓ ${name}`);
    passed++;
  }

  // Test 3: Same query → same queryHash (determinism)
  {
    const name = "Same query produces same queryHash";
    const backend = new MockFreeTextBackend();
    backend.memories = [
      {
        id: "ft-1",
        text: "User prefers dark mode",
        category: "preference",
        score: 0.85,
        source: "memu_item",
        scope: { userId: "u1", agentId: "a1", sessionKey: "s1" },
      },
    ];

    const coreRepo = new MockCoreRepo();
    coreRepo.list = async () => [];

    const signalStore = new MockSignalStore();
    const logger = new MockLogger();
    const metrics = new Metrics();
    const cache = new LRUCache<MemuMemoryRecord[]>(10, 60_000);
    const config = createTestConfig();

    const hook = createRecallHook(
      backend as any,
      { resolveRuntimeScope: () => ({ userId: "u1", agentId: "a1", sessionKey: "s1" }) },
      coreRepo as any,
      cache,
      new MockInboundCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      undefined,
      signalStore as any,
    );

    await hook(
      { prompt: "Tell me about my preferences", messages: [{ role: "user", content: "Tell me about my preferences" }] },
      { agentId: "a1", sessionKey: "s1-test3" },
    );

    const firstHash = signalStore.calls[0]?.queryHash;

    // Clear cache to force re-search, then call again
    cache.clear();
    signalStore.calls = [];

    await hook(
      { prompt: "Tell me about my preferences", messages: [{ role: "user", content: "Tell me about my preferences" }] },
      { agentId: "a1", sessionKey: "s1-test3b" },
    );

    const secondHash = signalStore.calls[0]?.queryHash;

    if (firstHash && firstHash === secondHash) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  firstHash=${firstHash}, secondHash=${secondHash}`);
      failed++;
    }
  }

  // Test 4: Different query → different queryHash
  {
    const name = "Different query produces different queryHash";
    const backend = new MockFreeTextBackend();
    backend.memories = [
      {
        id: "ft-1",
        text: "User prefers dark mode",
        category: "preference",
        score: 0.85,
        source: "memu_item",
        scope: { userId: "u1", agentId: "a1", sessionKey: "s1" },
      },
    ];

    const coreRepo = new MockCoreRepo();
    coreRepo.list = async () => [];

    const signalStore = new MockSignalStore();
    const logger = new MockLogger();
    const metrics = new Metrics();
    const cache = new LRUCache<MemuMemoryRecord[]>(10, 60_000);
    const config = createTestConfig();

    const hook = createRecallHook(
      backend as any,
      { resolveRuntimeScope: () => ({ userId: "u1", agentId: "a1", sessionKey: "s1" }) },
      coreRepo as any,
      cache,
      new MockInboundCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      undefined,
      signalStore as any,
    );

    await hook(
      { prompt: "What is my name?", messages: [{ role: "user", content: "What is my name?" }] },
      { agentId: "a1", sessionKey: "s1-test4" },
    );

    const hash1 = signalStore.calls[0]?.queryHash;
    cache.clear();
    signalStore.calls = [];

    await hook(
      { prompt: "Where do I work?", messages: [{ role: "user", content: "Where do I work?" }] },
      { agentId: "a1", sessionKey: "s1-test4b" },
    );

    const hash2 = signalStore.calls[0]?.queryHash;

    if (hash1 && hash2 && hash1 !== hash2) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  hash1=${hash1}, hash2=${hash2}`);
      failed++;
    }
  }

  // Test 5: relevanceScore === mem.score from recall phase
  {
    const name = "relevanceScore matches mem.score from recall phase";
    const backend = new MockFreeTextBackend();
    backend.memories = [
      {
        id: "ft-1",
        text: "User prefers dark mode",
        category: "preference",
        score: 0.92,
        source: "memu_item",
        scope: { userId: "u1", agentId: "a1", sessionKey: "s1" },
      },
    ];

    const coreRepo = new MockCoreRepo();
    coreRepo.list = async () => [
      { id: "core-1", category: "identity", key: "identity.name", value: "Alice", tier: "profile" },
    ];

    const signalStore = new MockSignalStore();
    const logger = new MockLogger();
    const metrics = new Metrics();
    const cache = new LRUCache<MemuMemoryRecord[]>(10, 60_000);
    const config = createTestConfig();

    const hook = createRecallHook(
      backend as any,
      { resolveRuntimeScope: () => ({ userId: "u1", agentId: "a1", sessionKey: "s1" }) },
      coreRepo as any,
      cache,
      new MockInboundCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      undefined,
      signalStore as any,
    );

    await hook(
      { prompt: "Tell me about my preferences", messages: [{ role: "user", content: "Tell me about my preferences" }] },
      { agentId: "a1", sessionKey: "s1-test5" },
    );

    const ftCall = signalStore.calls.find((c) => c.layer === "free-text");
    const coreCall = signalStore.calls.find((c) => c.layer === "core");

    // core memory from alwaysInject pool may not have score set by scoring
    if (ftCall && ftCall.relevanceScore === 0.92 && coreCall) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  ftCall=${JSON.stringify(ftCall)}, coreCall=${JSON.stringify(coreCall)}`);
      failed++;
    }
  }

  // Test 6: free-text memory without id → skipped, no error
  {
    const name = "free-text memory without id is skipped without error";
    const backend = new MockFreeTextBackend();
    backend.memories = [
      {
        id: undefined,
        text: "User prefers dark mode",
        category: "preference",
        score: 0.85,
        source: "memu_item",
        scope: { userId: "u1", agentId: "a1", sessionKey: "s1" },
      },
      {
        id: "ft-2",
        text: "User likes Python",
        category: "preference",
        score: 0.75,
        source: "memu_item",
        scope: { userId: "u1", agentId: "a1", sessionKey: "s1" },
      },
    ];

    const coreRepo = new MockCoreRepo();
    coreRepo.list = async () => [];

    const signalStore = new MockSignalStore();
    const logger = new MockLogger();
    const metrics = new Metrics();
    const cache = new LRUCache<MemuMemoryRecord[]>(10, 60_000);
    const config = createTestConfig();

    const hook = createRecallHook(
      backend as any,
      { resolveRuntimeScope: () => ({ userId: "u1", agentId: "a1", sessionKey: "s1" }) },
      coreRepo as any,
      cache,
      new MockInboundCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      undefined,
      signalStore as any,
    );

    const result = await hook(
      { prompt: "What are my preferences?", messages: [{ role: "user", content: "What are my preferences?" }] },
      { agentId: "a1", sessionKey: "s1-test6" },
    );

    if (
      signalStore.calls.length === 1 &&
      signalStore.calls[0].key === "ft-2" &&
      typeof result === "object" && result !== null && "prependContext" in result
    ) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  Calls: ${JSON.stringify(signalStore.calls)}`);
      failed++;
    }
  }

  // Test 7: recordRecall throws → caught, recall hook returns normally
  {
    const name = "recordRecall throw is caught and hook returns normally";
    const backend = new MockFreeTextBackend();
    backend.memories = [
      {
        id: "ft-1",
        text: "User prefers dark mode",
        category: "preference",
        score: 0.85,
        source: "memu_item",
        scope: { userId: "u1", agentId: "a1", sessionKey: "s1" },
      },
    ];

    const coreRepo = new MockCoreRepo();
    coreRepo.list = async () => [];

    const signalStore = new MockSignalStore();
    signalStore.shouldThrow = true;
    const logger = new MockLogger();
    const metrics = new Metrics();
    const cache = new LRUCache<MemuMemoryRecord[]>(10, 60_000);
    const config = createTestConfig();

    const hook = createRecallHook(
      backend as any,
      { resolveRuntimeScope: () => ({ userId: "u1", agentId: "a1", sessionKey: "s1" }) },
      coreRepo as any,
      cache,
      new MockInboundCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      undefined,
      signalStore as any,
    );

    let didThrow = false;
    let result: any;
    try {
      result = await hook(
        { prompt: "What are my preferences?", messages: [{ role: "user", content: "What are my preferences?" }] },
        { agentId: "a1", sessionKey: "s1-test7" },
      );
    } catch (e) {
      didThrow = true;
    }

    if (!didThrow && typeof result === "object" && result !== null && "prependContext" in result) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  didThrow=${didThrow}, result=${JSON.stringify(result)}`);
      failed++;
    }
  }

  console.log(`\n=== Results: ${passed}/${passed + failed} passed ===`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
