// ============================================================================
// Unit Tests for InboundMessageCache
// Run with: npx tsx tests/inbound-cache.test.ts
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InboundMessageCache } from "../inbound-cache.js";
import type { ClassificationResult } from "../types.js";

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

let tempDir: string;

function createCache(ttlMs = 60_000): InboundMessageCache {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-cache-test-"));
  return new InboundMessageCache(path.join(tempDir, "inbound.json"), ttlMs, 500, 0);
}

function cleanup(): void {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log("\nInboundMessageCache Tests\n");

// =============================================================================
// Basic message storage tests
// =============================================================================
console.log("  --- Message Storage Tests ---");

test("set and get message by sender", async () => {
  const cache = createCache();
  await cache.set("channel1", "user1", "Hello world");
  const result = await cache.getBySender("channel1", "user1");
  assertEqual(result, "Hello world", "message content");
  cleanup();
});

test("returns undefined for missing sender", async () => {
  const cache = createCache();
  const result = await cache.getBySender("channel1", "nonexistent");
  assertEqual(result, undefined, "missing sender");
  cleanup();
});

test("overwrites message for same sender", async () => {
  const cache = createCache();
  await cache.set("channel1", "user1", "First message");
  await cache.set("channel1", "user1", "Second message");
  const result = await cache.getBySender("channel1", "user1");
  assertEqual(result, "Second message", "overwritten message");
  cleanup();
});

test("isolates messages by channel", async () => {
  const cache = createCache();
  await cache.set("channel1", "user1", "Message in channel1");
  await cache.set("channel2", "user1", "Message in channel2");

  const result1 = await cache.getBySender("channel1", "user1");
  const result2 = await cache.getBySender("channel2", "user1");

  assertEqual(result1, "Message in channel1", "channel1 message");
  assertEqual(result2, "Message in channel2", "channel2 message");
  cleanup();
});

test("handles feishu: prefix normalization", async () => {
  const cache = createCache();
  await cache.set("channel1", "feishu:user1", "Hello");

  // Should be accessible with or without prefix
  const result1 = await cache.getBySender("channel1", "feishu:user1");
  const result2 = await cache.getBySender("channel1", "user1");

  assertEqual(result1, "Hello", "with prefix");
  assertEqual(result2, "Hello", "without prefix");
  cleanup();
});

test("skips empty content", async () => {
  const cache = createCache();
  await cache.set("channel1", "user1", "");
  const result = await cache.getBySender("channel1", "user1");
  assertEqual(result, undefined, "empty content skipped");
  cleanup();
});

test("skips whitespace-only content", async () => {
  const cache = createCache();
  await cache.set("channel1", "user1", "   ");
  const result = await cache.getBySender("channel1", "user1");
  assertEqual(result, undefined, "whitespace skipped");
  cleanup();
});

// =============================================================================
// Classification storage tests
// =============================================================================
console.log("\n  --- Classification Storage Tests ---");

const sampleClassification: ClassificationResult = {
  tier: "SIMPLE",
  queryType: "greeting",
  targetCategories: [],
  captureHint: "skip",
};

test("set and get classification", async () => {
  const cache = createCache();
  await cache.set("channel1", "user1", "Hello");
  await cache.setClassification("channel1", "user1", sampleClassification);

  const result = await cache.getClassification("channel1", "user1");
  assertDeepEqual(result, sampleClassification, "classification");
  cleanup();
});

test("returns undefined classification for missing sender", async () => {
  const cache = createCache();
  const result = await cache.getClassification("channel1", "nonexistent");
  assertEqual(result, undefined, "missing classification");
  cleanup();
});

test("classification requires existing message entry", async () => {
  const cache = createCache();
  // Set classification without setting message first
  await cache.setClassification("channel1", "user1", sampleClassification);
  const result = await cache.getClassification("channel1", "user1");
  assertEqual(result, undefined, "no classification without message");
  cleanup();
});

test("classification preserved on same entry", async () => {
  const cache = createCache();
  await cache.set("channel1", "user1", "Hello");
  await cache.setClassification("channel1", "user1", sampleClassification);

  // Get message should still work
  const msg = await cache.getBySender("channel1", "user1");
  assertEqual(msg, "Hello", "message still accessible");

  // Classification should still work
  const cls = await cache.getClassification("channel1", "user1");
  assertDeepEqual(cls, sampleClassification, "classification still accessible");
  cleanup();
});

test("classification with feishu: prefix normalization", async () => {
  const cache = createCache();
  await cache.set("channel1", "feishu:user1", "Hello");
  await cache.setClassification("channel1", "feishu:user1", sampleClassification);

  // Should be accessible with or without prefix
  const result1 = await cache.getClassification("channel1", "feishu:user1");
  const result2 = await cache.getClassification("channel1", "user1");

  assertDeepEqual(result1, sampleClassification, "with prefix");
  assertDeepEqual(result2, sampleClassification, "without prefix");
  cleanup();
});

test("different classifications for different channels", async () => {
  const cache = createCache();

  const cls1: ClassificationResult = {
    tier: "SIMPLE",
    queryType: "greeting",
    targetCategories: [],
    captureHint: "skip",
  };

  const cls2: ClassificationResult = {
    tier: "COMPLEX",
    queryType: "code",
    targetCategories: ["technical"],
    captureHint: "skip",
  };

  await cache.set("channel1", "user1", "Hello");
  await cache.set("channel2", "user1", "Check code");
  await cache.setClassification("channel1", "user1", cls1);
  await cache.setClassification("channel2", "user1", cls2);

  const result1 = await cache.getClassification("channel1", "user1");
  const result2 = await cache.getClassification("channel2", "user1");

  assertDeepEqual(result1, cls1, "channel1 classification");
  assertDeepEqual(result2, cls2, "channel2 classification");
  cleanup();
});

// =============================================================================
// Edge cases
// =============================================================================
console.log("\n  --- Edge Cases ---");

test("handles undefined senderId for set", async () => {
  const cache = createCache();
  // Should not throw
  await cache.set("channel1", undefined, "Hello");
  cleanup();
});

test("handles undefined senderId for setClassification", async () => {
  const cache = createCache();
  // Should not throw
  await cache.setClassification("channel1", undefined, sampleClassification);
  cleanup();
});

test("handles empty channelId", async () => {
  const cache = createCache();
  await cache.set("", "user1", "Hello");
  const result = await cache.getBySender("", "user1");
  assertEqual(result, undefined, "empty channel returns undefined");
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
