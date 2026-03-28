import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CoreMemoryRepository } from "../core-repository.js";
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

const testLogger = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
};

const scope: MemoryScope = {
  userId: "user_test",
  agentId: "agent_test",
  sessionKey: "agent:agent_test",
};

async function createRepo(): Promise<{ repo: CoreMemoryRepository; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "core-repo-"));
  return { repo: new CoreMemoryRepository(dir, testLogger, 240), dir };
}

console.log("\nCore Repository Tests\n");

await test("upsert and list persist local core records", async () => {
  const { repo, dir } = await createRepo();
  const ok = await repo.upsert(scope, {
    category: "profile",
    key: "profile.name",
    value: "Alice Doe",
    source: "test",
  });
  assert(ok, "upsert should succeed");

  const records = await repo.list(scope, { limit: 20 });
  assertEqual(records.length, 1, "record count");
  assertEqual(records[0]?.key, "profile.name", "key preserved");
  assertEqual(records[0]?.value, "Alice Doe", "value preserved");
  assertEqual(records[0]?.category, "identity", "category normalized");

  const raw = JSON.parse(await readFile(join(dir, "core-memory.json"), "utf-8"));
  assertEqual(raw.items.length, 1, "persisted item count");
});

await test("list ranks Chinese query-matching core facts above irrelevant high-importance facts", async () => {
  const { repo } = await createRepo();
  await repo.upsert(scope, {
    category: "identity",
    key: "identity.current_role",
    value: "用户现在的职业是某互联网公司高级后端工程师。",
    source: "test",
    importance: 10,
  });
  await repo.upsert(scope, {
    category: "identity",
    key: "identity.timezone",
    value: "用户的时区是 UTC+8。",
    source: "test",
    importance: 8,
  });

  const records = await repo.list(scope, { query: "用户的时区是什么？", limit: 2 });
  assertEqual(records[0]?.key, "identity.timezone", "timezone fact should rank first");
});

await test("upsertMany replaces existing records by category and key", async () => {
  const { repo } = await createRepo();
  await repo.upsert(scope, {
    category: "goals",
    key: "goals.primary",
    value: "先成为独立开发者。",
    source: "test",
  });

  const ok = await repo.upsertMany(scope, [
    { category: "goals", key: "goals.primary", value: "成为一人公司创业者。", provenance: "test" },
    { category: "identity", key: "identity.timezone", value: "UTC+8", provenance: "test" },
  ]);
  assert(ok, "upsertMany should succeed");

  const records = await repo.list(scope, { limit: 10 });
  assertEqual(records.length, 2, "should keep two scope records");
  const primary = records.find((record) => record.key === "goals.primary");
  assertEqual(primary?.value, "成为一人公司创业者。", "existing key should be replaced");
});

await test("delete removes record by id fallback", async () => {
  const { repo } = await createRepo();
  await repo.upsert(scope, {
    category: "identity",
    key: "identity.timezone",
    value: "UTC+8",
    source: "test",
  });
  const [record] = await repo.list(scope, { limit: 10 });
  const ok = await repo.delete(scope, { id: record!.id });
  assert(ok, "delete should succeed");
  const records = await repo.list(scope, { limit: 10 });
  assertEqual(records.length, 0, "record should be deleted");
});

await test("touch updates touchedAt for matching records", async () => {
  const { repo } = await createRepo();
  await repo.upsert(scope, {
    category: "identity",
    key: "identity.timezone",
    value: "UTC+8",
    source: "test",
  });
  const [record] = await repo.list(scope, { limit: 10 });
  const ok = await repo.touch(scope, { id: record!.id, kind: "injected" });
  assert(ok, "touch should succeed");
  const [after] = await repo.list(scope, { limit: 10 });
  assert(typeof after?.touchedAt === "number" && Number.isFinite(after.touchedAt), "touchedAt should be set");
});

// ── T1: TTL / validUntil ─────────────────────────────────────────────────────

await test("T1: upsert with already-expired validUntil is rejected", async () => {
  const { repo } = await createRepo();
  const ok = await repo.upsert(scope, {
    key: "test.ttl_expired",
    value: "should not be stored",
    validUntil: "2020-01-01T00:00:00Z",
  });
  assert(!ok, "upsert should fail for already-expired validUntil");
  const records = await repo.list(scope);
  assert(records.every((r) => r.key !== "test.ttl_expired"), "expired record must not appear in list");
});

await test("T1: upsert with future validUntil is accepted and returned by list", async () => {
  const { repo } = await createRepo();
  const ok = await repo.upsert(scope, {
    key: "test.ttl_future",
    value: "temporary fact",
    validUntil: "2099-01-01T00:00:00Z",
  });
  assert(ok, "upsert should succeed for future validUntil");
  const records = await repo.list(scope);
  assert(records.some((r) => r.key === "test.ttl_future"), "non-expired record must appear in list");
});

await test("T1: upsert with invalid validUntil string is rejected", async () => {
  const { repo } = await createRepo();
  const ok = await repo.upsert(scope, {
    key: "test.ttl_invalid",
    value: "bad date",
    validUntil: "not-a-date",
  });
  assert(!ok, "upsert should fail for invalid date string");
});

await test("T1: loadFromDisk drops expired records from persisted file", async () => {
  const { repo, dir } = await createRepo();
  // Write an expired record directly to the JSON file
  const expiredItem = {
    id: "expired-id-001",
    category: "general",
    key: "test.on_disk_expired",
    value: "stale value",
    expiresAt: 1000, // epoch ms in 1970 — long expired
    scope: { userId: "user_test", agentId: "agent_test" },
    createdAt: 1000,
    updatedAt: 1000,
  };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(dir, "core-memory.json"),
    JSON.stringify({ version: 1, items: [expiredItem] }),
    "utf-8",
  );
  const repo2 = new CoreMemoryRepository(dir, testLogger, 240);
  const records = await repo2.list(scope);
  assert(records.every((r) => r.key !== "test.on_disk_expired"), "expired record on disk must not be loaded");
});

await test("T1: touch does not resurrect an expired record", async () => {
  const { repo, dir } = await createRepo();
  const expiredItem = {
    id: "expired-touch-001",
    category: "general",
    key: "test.touch_expired",
    value: "expired fact",
    expiresAt: 1000,
    scope: { userId: "user_test", agentId: "agent_test" },
    createdAt: 1000,
    updatedAt: 1000,
  };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(dir, "core-memory.json"),
    JSON.stringify({ version: 1, items: [expiredItem] }),
    "utf-8",
  );
  const repo2 = new CoreMemoryRepository(dir, testLogger, 240);
  // touch by id should return false (expired record not found in live state)
  const ok = await repo2.touch(scope, { id: "expired-touch-001" });
  assert(!ok, "touch should not update an expired record");
  const records = await repo2.list(scope);
  assert(records.every((r) => r.key !== "test.touch_expired"), "expired record must not appear after touch attempt");
});

// ── T2: Load-time deduplication ───────────────────────────────────────────────

await test("T2: loadFromDisk deduplicates same key+scope, keeps newest by updatedAt", async () => {
  const { dir } = await createRepo();
  const older = {
    id: "dup-old-001",
    category: "general",
    key: "dup.key",
    value: "old value",
    scope: { userId: "user_test", agentId: "agent_test" },
    createdAt: 1000,
    updatedAt: 1000,
  };
  const newer = {
    id: "dup-new-001",
    category: "general",
    key: "dup.key",
    value: "new value",
    scope: { userId: "user_test", agentId: "agent_test" },
    createdAt: 2000,
    updatedAt: 2000,
  };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(dir, "core-memory.json"),
    JSON.stringify({ version: 1, items: [older, newer] }),
    "utf-8",
  );
  const repo2 = new CoreMemoryRepository(dir, testLogger, 240);
  const records = await repo2.list(scope);
  const dups = records.filter((r) => r.key === "dup.key");
  assertEqual(dups.length, 1, "should have exactly 1 record after dedup");
  assertEqual(dups[0]?.value, "new value", "should keep the newest record");
});

await test("T2: dedup is scoped — same key for different agentId produces two records", async () => {
  const { dir } = await createRepo();
  const scopeA = { userId: "user_test", agentId: "agent_a" };
  const scopeB = { userId: "user_test", agentId: "agent_b" };
  const itemA = { id: "scope-a-001", category: "general", key: "shared.key", value: "from A", scope: scopeA, createdAt: 1000, updatedAt: 1000 };
  const itemB = { id: "scope-b-001", category: "general", key: "shared.key", value: "from B", scope: scopeB, createdAt: 1000, updatedAt: 1000 };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(dir, "core-memory.json"),
    JSON.stringify({ version: 1, items: [itemA, itemB] }),
    "utf-8",
  );
  const repo2 = new CoreMemoryRepository(dir, testLogger, 240);
  const recordsA = await repo2.list({ userId: "user_test", agentId: "agent_a", sessionKey: "" });
  const recordsB = await repo2.list({ userId: "user_test", agentId: "agent_b", sessionKey: "" });
  assertEqual(recordsA.length, 1, "agent_a should have 1 record");
  assertEqual(recordsB.length, 1, "agent_b should have 1 record");
  assertEqual(recordsA[0]?.value, "from A", "agent_a sees its own value");
  assertEqual(recordsB[0]?.value, "from B", "agent_b sees its own value");
});

// ── T3: Knowledge dump guard ──────────────────────────────────────────────────

await test("T3: upsert rejects value with circled-number list markers", async () => {
  const { repo } = await createRepo();
  const ok = await repo.upsert(scope, {
    key: "test.knowledge_circled",
    value: "内容：①合并规划选址和用地预审；②合并建设用地规划许可和用地批准",
  });
  assert(!ok, "circled-number knowledge dump should be rejected");
});

await test("T3: upsert rejects value with citation marker （来源：", async () => {
  const { repo } = await createRepo();
  const ok = await repo.upsert(scope, {
    key: "test.knowledge_citation",
    value: "城市防洪规划（来源：2011版《相关知识》教材）：1)消防；2)防洪",
  });
  assert(!ok, "citation-marker knowledge dump should be rejected");
});

await test("T3: upsert rejects value with law article reference 第N条", async () => {
  const { repo } = await createRepo();
  const ok = await repo.upsert(scope, {
    key: "test.knowledge_law",
    value: "第一条规定：向市县自然资源主管部门申请，经批准后核发建设用地规划许可证",
  });
  assert(!ok, "law article reference should be rejected");
});

await test("T3: upsert rejects value with ≥4 numbered items", async () => {
  const { repo } = await createRepo();
  const ok = await repo.upsert(scope, {
    key: "test.knowledge_numbered",
    value: "内容：1)合并；2)合并建设用地；3)划拨方式；4)出让方式",
  });
  assert(!ok, "4+ numbered item list should be rejected");
});

await test("T3: upsert accepts normal personal fact (Chinese)", async () => {
  const { repo } = await createRepo();
  const ok = await repo.upsert(scope, { key: "identity.name", value: "用户叫昊" });
  assert(ok, "personal fact should be accepted");
});

await test("T3: upsert accepts preference with ≤3 numbered items", async () => {
  const { repo } = await createRepo();
  const ok = await repo.upsert(scope, {
    key: "preferences.priority",
    value: "我的三个目标：1)健身 2)创业 3)学习",
  });
  assert(ok, "3-item preference list should not be blocked");
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
