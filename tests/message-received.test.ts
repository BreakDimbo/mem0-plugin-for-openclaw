// ============================================================================
// Unit Tests for message-received hook (simplified: cache-only)
// Run with: npx tsx tests/message-received.test.ts
// ============================================================================

import { createMessageReceivedHook } from "../hooks/message-received.js";

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
  };
}

const baseCtx = {
  channelId: "ch_123",
};

console.log("\nMessage-Received Hook Tests (Simplified)\n");

await test("caches inbound message", async () => {
  const cache = createMockCache();
  const hook = createMessageReceivedHook(cache as any, testLogger);
  await hook({ from: "user1", content: "我喜欢用Obsidian做笔记" }, baseCtx);

  assertEqual(cache.stored.length, 1, "should cache 1 message");
  assertEqual(cache.stored[0].channelId, "ch_123", "correct channelId");
  assertEqual(cache.stored[0].from, "user1", "correct from");
  assertEqual(cache.stored[0].content, "我喜欢用Obsidian做笔记", "correct content");
});

await test("caches system messages (for recall query extraction)", async () => {
  const cache = createMockCache();
  const hook = createMessageReceivedHook(cache as any, testLogger);
  await hook({ from: "user1", content: "[system] internal message" }, baseCtx);

  assertEqual(cache.stored.length, 1, "system messages cached for recall");
});

await test("caches low-signal messages (for recall query extraction)", async () => {
  const cache = createMockCache();
  const hook = createMessageReceivedHook(cache as any, testLogger);
  await hook({ from: "user1", content: "好的" }, baseCtx);

  assertEqual(cache.stored.length, 1, "low-signal still cached");
});

await test("skips empty content", async () => {
  const cache = createMockCache();
  const hook = createMessageReceivedHook(cache as any, testLogger);
  await hook({ from: "user1", content: "" }, baseCtx);
  await hook({ from: "user1", content: "   " }, baseCtx);

  assertEqual(cache.stored.length, 0, "should not cache empty content");
});

await test("skips when channelId missing", async () => {
  const cache = createMockCache();
  const hook = createMessageReceivedHook(cache as any, testLogger);
  await hook({ from: "user1", content: "some message" }, { channelId: "" });

  assertEqual(cache.stored.length, 0, "should not cache without channelId");
});

await test("trims content before caching", async () => {
  const cache = createMockCache();
  const hook = createMessageReceivedHook(cache as any, testLogger);
  await hook({ from: "user1", content: "  hello world  " }, baseCtx);

  assertEqual(cache.stored[0].content, "hello world", "content should be trimmed");
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
