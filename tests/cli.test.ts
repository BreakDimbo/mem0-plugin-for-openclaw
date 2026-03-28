// ============================================================================
// Tests: cli.ts — pure helper functions
// Run with: npx tsx tests/cli.test.ts
// ============================================================================

import { parseCoreRef, inferPeerKindFromId, looksLikeConversationId } from "../cli.js";

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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEqual(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log("\nCLI Helper Tests\n");

// ── parseCoreRef ──────────────────────────────────────────────────────────────

test("parseCoreRef: undefined/empty → {}", () => {
  const r1 = parseCoreRef(undefined);
  assert(!r1.id && !r1.key, "undefined → empty");
  const r2 = parseCoreRef("   ");
  assert(!r2.id && !r2.key, "whitespace → empty");
  const r3 = parseCoreRef("");
  assert(!r3.id && !r3.key, "empty string → empty");
});

test("parseCoreRef: 'id:<uuid>' → { id }", () => {
  const r = parseCoreRef("id:abc-123");
  assertEqual(r.id, "abc-123", "id extracted");
  assertEqual(r.key, undefined, "no key");
});

test("parseCoreRef: 'id:' (empty after prefix) → { id: undefined }", () => {
  const r = parseCoreRef("id:");
  assertEqual(r.id, undefined, "empty id after prefix → undefined");
});

test("parseCoreRef: 'key:preferences.editor' → { key }", () => {
  const r = parseCoreRef("key:preferences.editor");
  assertEqual(r.key, "preferences.editor", "key extracted");
  assertEqual(r.id, undefined, "no id");
});

test("parseCoreRef: dotted token → treated as key", () => {
  const r = parseCoreRef("identity.name");
  assertEqual(r.key, "identity.name", "dotted token → key");
  assertEqual(r.id, undefined, "no id");
});

test("parseCoreRef: bare token without dot → treated as id", () => {
  const r = parseCoreRef("someplaintoken");
  assertEqual(r.id, "someplaintoken", "bare token → id");
  assertEqual(r.key, undefined, "no key");
});

// ── inferPeerKindFromId ───────────────────────────────────────────────────────

test("inferPeerKindFromId: 'channel:...' → 'channel'", () => {
  assertEqual(inferPeerKindFromId("channel:general"), "channel", "channel prefix");
  assertEqual(inferPeerKindFromId("CHANNEL:general"), "channel", "case insensitive");
});

test("inferPeerKindFromId: 'group:...' → 'group'", () => {
  assertEqual(inferPeerKindFromId("group:devs"), "group", "group prefix");
  assertEqual(inferPeerKindFromId("chat:devs"), "group", "chat prefix → group");
  assertEqual(inferPeerKindFromId("room:lobby"), "group", "room prefix → group");
});

test("inferPeerKindFromId: contains ':channel:' → 'channel'", () => {
  assertEqual(inferPeerKindFromId("tenant1:channel:announcements"), "channel", "embedded :channel:");
});

test("inferPeerKindFromId: contains ':group:' → 'group'", () => {
  assertEqual(inferPeerKindFromId("tenant1:group:devs"), "group", "embedded :group:");
});

test("inferPeerKindFromId: WhatsApp @g.us → 'group'", () => {
  assertEqual(inferPeerKindFromId("123456789@g.us"), "group", "whatsapp group JID");
});

test("inferPeerKindFromId: plain user id → 'direct'", () => {
  assertEqual(inferPeerKindFromId("alice"), "direct", "plain string → direct");
  assertEqual(inferPeerKindFromId("user:alice"), "direct", "user: prefix → direct");
  assertEqual(inferPeerKindFromId(""), "direct", "empty → direct");
});

// ── looksLikeConversationId ───────────────────────────────────────────────────

test("looksLikeConversationId: empty/blank → false", () => {
  assert(!looksLikeConversationId(""), "empty → false");
  assert(!looksLikeConversationId("  "), "blank → false");
});

test("looksLikeConversationId: known prefixes → true", () => {
  assert(looksLikeConversationId("user:alice"), "user: → true");
  assert(looksLikeConversationId("chat:123"), "chat: → true");
  assert(looksLikeConversationId("channel:general"), "channel: → true");
  assert(looksLikeConversationId("group:devs"), "group: → true");
  assert(looksLikeConversationId("room:lobby"), "room: → true");
});

test("looksLikeConversationId: embedded patterns → true", () => {
  assert(looksLikeConversationId("t1:group:devs"), ":group: → true");
  assert(looksLikeConversationId("t1:channel:news"), ":channel: → true");
  assert(looksLikeConversationId("123@g.us"), "@g.us → true");
});

test("looksLikeConversationId: bare opaque ids → false", () => {
  assert(!looksLikeConversationId("alice"), "bare name → false");
  assert(!looksLikeConversationId("abc123def"), "opaque id → false");
});

// Summary
console.log();
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
