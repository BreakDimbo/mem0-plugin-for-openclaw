// ============================================================================
// Unit Tests for Core Proposal extraction
// Run with: npx tsx tests/core-proposals.test.ts
// ============================================================================

import { CoreProposalQueue, extractCoreProposal } from "../core-proposals.js";
import type { MemoryScope } from "../types.js";

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

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const scope: MemoryScope = {
  userId: "user_test",
  agentId: "agent_test",
  sessionKey: "agent:agent_test:main",
};

console.log("\nCore Proposal Tests\n");

await test("extracts stable preference statement", async () => {
  const proposal = extractCoreProposal("I always want concise answers with direct conclusions.", scope);
  assert(!!proposal, "proposal should be extracted");
  assertEqual(proposal?.category, "preferences", "category");
});

await test("extracts stable long-term goal statement", async () => {
  const proposal = extractCoreProposal("My long-term goal is to build a profitable one-person AI business.", scope);
  assert(!!proposal, "proposal should be extracted");
  assertEqual(proposal?.category, "goals", "category");
});

await test("rejects short-term plan statements", async () => {
  const proposal = extractCoreProposal("用户计划于明天开始学习打羽毛球。", scope);
  assertEqual(proposal, null, "short-term plan should not become core proposal");
});

await test("rejects test and debug chatter", async () => {
  const proposal = extractCoreProposal("This is a memory-memu outbox test for debug verification.", scope);
  assertEqual(proposal, null, "test chatter should not become core proposal");
});

await test("rejects generic remember requests", async () => {
  const proposal = extractCoreProposal("Remember that tomorrow I need to buy breakfast.", scope);
  assertEqual(proposal, null, "generic remember request should stay out of core");
});

await test("extracts Chinese durable profile fact", async () => {
  const proposal = extractCoreProposal("我的时区是 UTC+8。", scope);
  assert(!!proposal, "proposal should be extracted");
  assertEqual(proposal?.category, "identity", "category");
  assertEqual(proposal?.value, "UTC+8", "value");
});

await test("extracts Chinese durable preference fact with stable fallback key suffix", async () => {
  const proposal = extractCoreProposal("我偏好异步沟通。", scope);
  assert(!!proposal, "proposal should be extracted");
  assertEqual(proposal?.category, "preferences", "category");
  assert(proposal?.key.startsWith("preferences.") ?? false, "key prefix");
});

await test("scope-guarded proposal approval only reviews matching scope", async () => {
  const queue = new CoreProposalQueue("", 20, { info: () => {}, warn: () => {} });
  const foreignScope: MemoryScope = { userId: "other_user", agentId: "other_agent", sessionKey: "agent:other_agent:main" };
  const proposal = queue.enqueue({
    category: "identity",
    text: "我的时区是 UTC+8。",
    key: "identity.timezone",
    value: "UTC+8",
    reason: "user profile statement",
    scope: foreignScope,
  });
  const approved = queue.approveForScope(proposal.id, scope, "tool");
  assertEqual(approved, null, "foreign-scope proposal should not be approved");
});

// -- Summary --
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
