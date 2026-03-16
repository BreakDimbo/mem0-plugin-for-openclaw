// ============================================================================
// Unit Tests for Smart Router Hook
// Run with: npx tsx tests/smart-router.test.ts
// ============================================================================

import { createSmartRouterHook } from "../hooks/smart-router.js";
import { UnifiedIntentClassifier } from "../classifier.js";
import { LRUCache } from "../cache.js";
import { InboundMessageCache } from "../inbound-cache.js";
import type { MemuPluginConfig, ClassificationResult, ClassifierConfig } from "../types.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  const run = async () => {
    try {
      await fn();
      results.push({ name, passed: true });
      console.log(`  ✓ ${name}`);
    } catch (err) {
      results.push({ name, passed: false, error: String(err) });
      console.log(`  ✗ ${name}: ${String(err)}`);
    }
  };
  run();
}

function assertEqual<T>(a: T, b: T, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertDeepEqual<T>(a: T, b: T, msg: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const logMessages: string[] = [];
const mockLogger = {
  info: (msg: string) => logMessages.push(msg),
  warn: (msg: string) => logMessages.push(msg),
};

function createMockClassifier(fixedResult?: ClassificationResult): UnifiedIntentClassifier {
  const cache = new LRUCache<ClassificationResult>(100, 60_000);
  const metrics = { classifierCalls: 0, classifierHits: 0, classifierErrors: 0 };
  const config: ClassifierConfig = { enabled: true };

  const classifier = new UnifiedIntentClassifier(config, cache, metrics, mockLogger);

  // Override classify to return fixed result for testing
  if (fixedResult) {
    (classifier as any).classify = async () => fixedResult;
  }

  return classifier;
}

function createMockConfig(tierModels?: Record<string, string>): MemuPluginConfig {
  return {
    smartRouter: {
      enabled: true,
      tierModels: tierModels || {
        SIMPLE: "llmbox/glm-5",
        MEDIUM: "llmbox/kimi-k2.5",
        COMPLEX: "llmbox-openai/gpt-5.4",
        REASONING: "llmbox-openai/gpt-5.4",
      },
    },
    // Minimal config for other required fields
    scope: { userId: "test" },
    backend: { freeText: { provider: "mem0" } },
    mem0: { mode: "open-source" },
    recall: { enabled: false, method: "rag", threshold: 0.5, limit: 10, cacheMaxSize: 100, cacheTtlMs: 60000, alwaysInjectCategories: [], hybrid: { enabled: false, alpha: 0.7, fallbackToRag: false } },
    capture: { enabled: false, maxItemsPerRun: 3, minChars: 10, maxChars: 500, dedupeThreshold: 0.8, candidateQueue: { enabled: false, intervalMs: 10000, maxBatchSize: 50 } },
    core: { enabled: false, persistPath: "/tmp", maxItemChars: 500, alwaysInjectLimit: 10, proposalQueueMax: 100, humanReviewRequired: false, autoExtractProposals: false, llmGate: { enabled: false }, consolidation: { enabled: false, intervalMs: 3600000, similarityThreshold: 0.85 } },
    outbox: { enabled: false, concurrency: 1, batchSize: 10, maxRetries: 3, persistPath: "/tmp", flushIntervalMs: 10000, drainTimeoutMs: 5000 },
    sync: { enabled: false, intervalMs: 60000, memoryFilePath: "/tmp/MEMORY.md" },
    classifier: { enabled: true },
  } as unknown as MemuPluginConfig;
}

let tempDir: string;

function createInboundCache(): InboundMessageCache {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-router-test-"));
  return new InboundMessageCache(path.join(tempDir, "inbound.json"));
}

function cleanup(): void {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  logMessages.length = 0;
}

console.log("\nSmart Router Hook Tests\n");

// =============================================================================
// Basic routing tests
// =============================================================================
console.log("  --- Basic Routing Tests ---");

test("routes SIMPLE tier to configured model", async () => {
  const classifier = createMockClassifier({
    tier: "SIMPLE",
    queryType: "greeting",
    targetCategories: [],
    captureHint: "skip",
  });
  const config = createMockConfig();
  const inbound = createInboundCache();

  const hook = createSmartRouterHook(classifier, inbound, config, mockLogger);
  const result = await hook({ prompt: "你好" }, {});

  assertEqual(result?.providerOverride, "llmbox", "provider");
  assertEqual(result?.modelOverride, "glm-5", "model");

  cleanup();
});

test("routes MEDIUM tier to configured model", async () => {
  const classifier = createMockClassifier({
    tier: "MEDIUM",
    queryType: "factual",
    targetCategories: ["identity"],
    captureHint: "full",
  });
  const config = createMockConfig();
  const inbound = createInboundCache();

  const hook = createSmartRouterHook(classifier, inbound, config, mockLogger);
  const result = await hook({ prompt: "我叫什么名字" }, {});

  assertEqual(result?.providerOverride, "llmbox", "provider");
  assertEqual(result?.modelOverride, "kimi-k2.5", "model");

  cleanup();
});

test("routes COMPLEX tier to configured model", async () => {
  const classifier = createMockClassifier({
    tier: "COMPLEX",
    queryType: "code",
    targetCategories: ["technical"],
    captureHint: "skip",
  });
  const config = createMockConfig();
  const inbound = createInboundCache();

  const hook = createSmartRouterHook(classifier, inbound, config, mockLogger);
  const result = await hook({ prompt: "分析这段代码" }, {});

  assertEqual(result?.providerOverride, "llmbox-openai", "provider");
  assertEqual(result?.modelOverride, "gpt-5.4", "model");

  cleanup();
});

test("routes REASONING tier to configured model", async () => {
  const classifier = createMockClassifier({
    tier: "REASONING",
    queryType: "planning",
    targetCategories: [],
    captureHint: "full",
  });
  const config = createMockConfig();
  const inbound = createInboundCache();

  const hook = createSmartRouterHook(classifier, inbound, config, mockLogger);
  const result = await hook({ prompt: "设计一个微服务架构" }, {});

  assertEqual(result?.providerOverride, "llmbox-openai", "provider");
  assertEqual(result?.modelOverride, "gpt-5.4", "model");

  cleanup();
});

// =============================================================================
// Model format tests
// =============================================================================
console.log("\n  --- Model Format Tests ---");

test("handles model without provider prefix", async () => {
  const classifier = createMockClassifier({
    tier: "SIMPLE",
    queryType: "greeting",
    targetCategories: [],
    captureHint: "skip",
  });
  const config = createMockConfig({ SIMPLE: "gpt-4" }); // No provider prefix
  const inbound = createInboundCache();

  const hook = createSmartRouterHook(classifier, inbound, config, mockLogger);
  const result = await hook({ prompt: "你好" }, {});

  assertEqual(result?.modelOverride, "gpt-4", "model");
  assertEqual(result?.providerOverride, undefined, "no provider");

  cleanup();
});

test("returns undefined for unconfigured tier", async () => {
  const classifier = createMockClassifier({
    tier: "SIMPLE",
    queryType: "greeting",
    targetCategories: [],
    captureHint: "skip",
  });
  const config = createMockConfig({}); // No tier models configured
  const inbound = createInboundCache();

  const hook = createSmartRouterHook(classifier, inbound, config, mockLogger);
  const result = await hook({ prompt: "你好" }, {});

  assertEqual(result, undefined, "no override");

  cleanup();
});

// =============================================================================
// Disabled state tests
// =============================================================================
console.log("\n  --- Disabled State Tests ---");

test("returns undefined when smart router disabled", async () => {
  const classifier = createMockClassifier({
    tier: "SIMPLE",
    queryType: "greeting",
    targetCategories: [],
    captureHint: "skip",
  });
  const config = createMockConfig();
  config.smartRouter.enabled = false;
  const inbound = createInboundCache();

  const hook = createSmartRouterHook(classifier, inbound, config, mockLogger);
  const result = await hook({ prompt: "你好" }, {});

  assertEqual(result, undefined, "no override when disabled");

  cleanup();
});

test("returns undefined when classifier is undefined", async () => {
  const config = createMockConfig();
  const inbound = createInboundCache();

  const hook = createSmartRouterHook(undefined, inbound, config, mockLogger);
  const result = await hook({ prompt: "你好" }, {});

  assertEqual(result, undefined, "no override without classifier");

  cleanup();
});

// =============================================================================
// Query extraction tests
// =============================================================================
console.log("\n  --- Query Extraction Tests ---");

test("extracts query from messages array", async () => {
  const classifier = createMockClassifier({
    tier: "SIMPLE",
    queryType: "greeting",
    targetCategories: [],
    captureHint: "skip",
  });
  const config = createMockConfig();
  const inbound = createInboundCache();

  const hook = createSmartRouterHook(classifier, inbound, config, mockLogger);
  const result = await hook({
    messages: [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "你好" },
    ],
  }, {});

  assertEqual(result?.providerOverride, "llmbox", "provider from messages");

  cleanup();
});

test("extracts query from structured content blocks", async () => {
  const classifier = createMockClassifier({
    tier: "SIMPLE",
    queryType: "greeting",
    targetCategories: [],
    captureHint: "skip",
  });
  const config = createMockConfig();
  const inbound = createInboundCache();

  const hook = createSmartRouterHook(classifier, inbound, config, mockLogger);
  const result = await hook({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "你好" },
          { type: "image", data: "..." },
        ],
      },
    ],
  }, {});

  assertEqual(result?.providerOverride, "llmbox", "provider from structured content");

  cleanup();
});

test("skips very short queries", async () => {
  const classifier = createMockClassifier({
    tier: "SIMPLE",
    queryType: "greeting",
    targetCategories: [],
    captureHint: "skip",
  });
  const config = createMockConfig();
  const inbound = createInboundCache();

  const hook = createSmartRouterHook(classifier, inbound, config, mockLogger);
  const result = await hook({ prompt: "a" }, {});

  assertEqual(result, undefined, "skip short query");

  cleanup();
});

test("skips empty queries", async () => {
  const classifier = createMockClassifier({
    tier: "SIMPLE",
    queryType: "greeting",
    targetCategories: [],
    captureHint: "skip",
  });
  const config = createMockConfig();
  const inbound = createInboundCache();

  const hook = createSmartRouterHook(classifier, inbound, config, mockLogger);
  const result = await hook({ prompt: "   " }, {});

  assertEqual(result, undefined, "skip empty query");

  cleanup();
});

// =============================================================================
// Summary
// =============================================================================
setTimeout(() => {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}, 2000);
