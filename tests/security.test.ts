// ============================================================================
// Unit Tests for security module
// Run with: npx tsx tests/security.test.ts
// ============================================================================

import {
  escapeForInjection,
  isSensitiveContent,
  shouldCapture,
  formatCoreMemoriesContext,
  formatMemoriesContext,
  audit,
  getAuditLog,
} from "../security.js";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, passed: false, error: String(err) });
    console.log(`  ✗ ${name}: ${String(err)}`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log("\nSecurity Module Tests\n");

// -- escapeForInjection --
console.log("escapeForInjection:");

test("escapes HTML/XML characters", () => {
  assertEqual(escapeForInjection("<script>alert('xss')</script>"), "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;", "escape");
});

test("escapes ampersand and quotes", () => {
  assertEqual(escapeForInjection('a & b "c"'), "a &amp; b &quot;c&quot;", "escape");
});

test("passes through clean text", () => {
  assertEqual(escapeForInjection("hello world"), "hello world", "no change");
});

// -- isSensitiveContent --
console.log("\nisSensitiveContent:");

test("detects Chinese phone numbers", () => {
  assert(isSensitiveContent("Call me at 13812345678"), "should detect");
});

test("detects email addresses", () => {
  assert(isSensitiveContent("Email me at test@example.com"), "should detect");
});

test("detects API keys", () => {
  assert(isSensitiveContent("My key is sk-abcdefghijklmnopqrstuvwxyz"), "should detect");
});

test("allows normal text", () => {
  assert(!isSensitiveContent("I like programming in Go"), "should not detect");
});

// -- shouldCapture --
console.log("\nshouldCapture:");

test("rejects text too short", () => {
  const result = shouldCapture("hi", 10, 500);
  assert(!result.allowed, "too short");
});

test("rejects text too long", () => {
  const result = shouldCapture("a".repeat(501), 10, 500);
  assert(!result.allowed, "too long");
});

test("rejects API-key-like text as sensitive", () => {
  const result = shouldCapture("My api key is sk-abcdefghijklmnopqrstuvwxyz1234", 10, 500);
  assert(!result.allowed, "sensitive content should be rejected");
});

test("accepts normal text", () => {
  const result = shouldCapture("I prefer concise changelogs for my projects", 10, 500);
  assert(result.allowed, "normal text");
});

// -- formatMemoriesContext --
console.log("\nformatMemoriesContext:");

test("formats memories with xml tags", () => {
  const result = formatMemoriesContext([
    { text: "User prefers dark mode", category: "preference", score: 0.85 },
    { text: "Team uses Go for backend", category: "decision" },
  ] as any);
  assert(result.includes("<relevant-memories>"), "should have opening tag");
  assert(result.includes("</relevant-memories>"), "should have closing tag");
  assert(result.includes("补充历史事实"), "should include compact Chinese guidance");
  assert(result.includes("[preference]"), "should include category tag");
  assert(result.includes("User prefers dark mode"), "should include text");
});

test("returns empty for no memories", () => {
  assertEqual(formatMemoriesContext([]), "", "should be empty");
});

test("formats core memories with direct-answer guidance", () => {
  const result = formatCoreMemoriesContext([
    { id: "1", key: "identity.timezone", category: "identity", value: "用户的时区是 UTC+8。", scope: { userId: "u", agentId: "a", sessionKey: "s" } },
  ]);
  assert(result.includes("<core-memory>"), "should have opening tag");
  assert(result.includes("若这里已覆盖答案，直接据此作答"), "should include direct-answer guidance");
  assert(result.includes("[identity/timezone]"), "should use simplified tag (identity/identity.timezone -> identity/timezone)");
  assert(result.includes("用户的时区是 UTC+8。"), "should include value");
});

// -- audit --
console.log("\naudit:");

test("records audit entries", () => {
  audit("store", "user1", "agent1", "test detail");
  const log = getAuditLog(1);
  assert(log.length === 1, "should have 1 entry");
  assertEqual(log[0].action, "store", "action");
  assertEqual(log[0].userId, "user1", "userId");
  assertEqual(log[0].details, "test detail", "details");
});

// -- Summary --
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
