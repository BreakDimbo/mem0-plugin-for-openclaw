// ============================================================================
// Unit Tests for UnifiedIntentClassifier
// Run with: npx tsx tests/classifier.test.ts
// ============================================================================

import { UnifiedIntentClassifier, DEFAULT_CLASSIFICATION } from "../classifier.js";
import { LRUCache } from "../cache.js";
import type { ClassificationResult, ClassifierConfig } from "../types.js";

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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(a: T, b: T, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertDeepEqual<T>(a: T, b: T, msg: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const mockLogger = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
};

function createClassifier(enabled = true): {
  classifier: UnifiedIntentClassifier;
  cache: LRUCache<ClassificationResult>;
  metrics: { classifierCalls: number; classifierHits: number; classifierErrors: number };
} {
  const cache = new LRUCache<ClassificationResult>(100, 60_000);
  const metrics = { classifierCalls: 0, classifierHits: 0, classifierErrors: 0 };
  const config: ClassifierConfig = {
    enabled,
    model: "test-model",
    apiBase: "https://test.api",
    apiKey: undefined, // No API key for fast-path tests
  };
  const classifier = new UnifiedIntentClassifier(config, cache, metrics, mockLogger);
  return { classifier, cache, metrics };
}

console.log("\nUnifiedIntentClassifier Tests\n");

// =============================================================================
// Test: DEFAULT_CLASSIFICATION export
// =============================================================================
test("DEFAULT_CLASSIFICATION has expected values", () => {
  assertEqual(DEFAULT_CLASSIFICATION.tier, "MEDIUM", "tier");
  assertEqual(DEFAULT_CLASSIFICATION.queryType, "open", "queryType");
  assertDeepEqual(DEFAULT_CLASSIFICATION.targetCategories, [], "targetCategories");
  assertEqual(DEFAULT_CLASSIFICATION.captureHint, "full", "captureHint");
});

// =============================================================================
// Test: Classifier returns default when disabled
// =============================================================================
test("returns default when disabled", async () => {
  const { classifier } = createClassifier(false);
  const result = await classifier.classify("你好");
  assertDeepEqual(result, DEFAULT_CLASSIFICATION, "should return default");
});

// =============================================================================
// Fast classification tests (no LLM call needed)
// =============================================================================
console.log("\n  --- Fast Classification Tests ---");

test("fast classify: greeting '你好'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("你好");
  assertEqual(result.tier, "SIMPLE", "tier");
  assertEqual(result.queryType, "greeting", "queryType");
  assertEqual(result.captureHint, "skip", "captureHint");
});

test("fast classify: greeting 'hello!'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("hello!");
  assertEqual(result.tier, "SIMPLE", "tier");
  assertEqual(result.queryType, "greeting", "queryType");
  assertEqual(result.captureHint, "skip", "captureHint");
});

test("fast classify: greeting '早'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("早");
  assertEqual(result.tier, "SIMPLE", "tier");
  assertEqual(result.queryType, "greeting", "queryType");
});

test("fast classify: acknowledgment 'ok'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("ok");
  assertEqual(result.tier, "SIMPLE", "tier");
  assertEqual(result.queryType, "greeting", "queryType");
  assertEqual(result.captureHint, "skip", "captureHint");
});

test("fast classify: acknowledgment '好的'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("好的");
  assertEqual(result.tier, "SIMPLE", "tier");
  assertEqual(result.queryType, "greeting", "queryType");
});

test("fast classify: acknowledgment '谢谢'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("谢谢");
  assertEqual(result.tier, "SIMPLE", "tier");
  assertEqual(result.queryType, "greeting", "queryType");
});

test("fast classify: code '检查 index.ts 的代码'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("检查 index.ts 的代码");
  assertEqual(result.tier, "COMPLEX", "tier");
  assertEqual(result.queryType, "code", "queryType");
  assertEqual(result.captureHint, "skip", "captureHint");
  assert(result.targetCategories.includes("technical"), "should include technical category");
});

test("fast classify: code '帮我看看 utils.js'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("帮我看看 utils.js");
  assertEqual(result.tier, "COMPLEX", "tier");
  assertEqual(result.queryType, "code", "queryType");
});

test("fast classify: debug '报错了'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("报错了");
  assertEqual(result.tier, "COMPLEX", "tier");
  assertEqual(result.queryType, "debug", "queryType");
  assertEqual(result.captureHint, "skip", "captureHint");
});

test("fast classify: debug '为什么这个不工作'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("为什么这个不工作");
  assertEqual(result.tier, "COMPLEX", "tier");
  assertEqual(result.queryType, "debug", "queryType");
});

test("fast classify: debug 'how to fix this error'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("how to fix this error");
  assertEqual(result.tier, "COMPLEX", "tier");
  assertEqual(result.queryType, "debug", "queryType");
});

test("fast classify: identity '我叫什么名字'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("我叫什么名字");
  assertEqual(result.tier, "SIMPLE", "tier");
  assertEqual(result.queryType, "factual", "queryType");
  assertEqual(result.captureHint, "full", "captureHint");
  assert(result.targetCategories.includes("identity"), "should include identity category");
});

test("fast classify: identity '我的名字'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("我的名字");
  assertEqual(result.tier, "SIMPLE", "tier");
  assertEqual(result.queryType, "factual", "queryType");
});

test("fast classify: identity 'what is my name'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("what is my name");
  assertEqual(result.tier, "SIMPLE", "tier");
  assertEqual(result.queryType, "factual", "queryType");
});

test("fast classify: timezone '我的时区是什么'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("我的时区是什么");
  assertEqual(result.tier, "SIMPLE", "tier");
  assertEqual(result.queryType, "factual", "queryType");
  assert(result.targetCategories.includes("identity"), "should include identity category");
});

test("fast classify: preference '我喜欢什么'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("我喜欢什么");
  assertEqual(result.tier, "MEDIUM", "tier");
  assertEqual(result.queryType, "preference", "queryType");
  assertEqual(result.captureHint, "full", "captureHint");
  assert(result.targetCategories.includes("preferences"), "should include preferences category");
});

test("fast classify: preference '我偏好什么'", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("我偏好什么");
  assertEqual(result.tier, "MEDIUM", "tier");
  assertEqual(result.queryType, "preference", "queryType");
});

// =============================================================================
// Cache tests
// =============================================================================
console.log("\n  --- Cache Tests ---");

test("cache hit on repeated query", async () => {
  const { classifier, metrics } = createClassifier();

  // First call
  await classifier.classify("你好");
  assertEqual(metrics.classifierHits, 0, "no hits on first call");

  // Second call (should hit cache)
  await classifier.classify("你好");
  assertEqual(metrics.classifierHits, 1, "hit cache on second call");
});

test("cache respects case normalization", async () => {
  const { classifier, metrics } = createClassifier();

  await classifier.classify("Hello");
  await classifier.classify("hello");
  assertEqual(metrics.classifierHits, 1, "cache hit despite case difference");
});

test("cache respects whitespace normalization", async () => {
  const { classifier, metrics } = createClassifier();

  await classifier.classify("你好");
  await classifier.classify("  你好  ");
  assertEqual(metrics.classifierHits, 1, "cache hit despite whitespace");
});

// =============================================================================
// Edge cases
// =============================================================================
console.log("\n  --- Edge Cases ---");

test("empty query returns default (no API key)", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("");
  // Empty query won't match fast patterns, will try LLM but no API key -> default
  assertDeepEqual(result, DEFAULT_CLASSIFICATION, "empty query should return default");
});

test("very long query is truncated for cache key", async () => {
  const { classifier, metrics } = createClassifier();
  const longQuery = "我叫什么名字".repeat(100);

  await classifier.classify(longQuery);
  await classifier.classify(longQuery);
  assertEqual(metrics.classifierHits, 1, "long query cached correctly");
});

test("queries not matching patterns return default (no API key)", async () => {
  const { classifier } = createClassifier();
  const result = await classifier.classify("给我讲个故事吧");
  // No fast pattern match, no API key -> default
  assertDeepEqual(result, DEFAULT_CLASSIFICATION, "unmatched query without API key");
});

// =============================================================================
// Summary
// =============================================================================
setTimeout(() => {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}, 1000);
