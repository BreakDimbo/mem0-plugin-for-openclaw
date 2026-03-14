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

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
