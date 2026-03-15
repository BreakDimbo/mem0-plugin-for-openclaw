// ============================================================================
// Unit Tests for Core Memory Consolidation
// Run with: npx tsx tests/core-consolidation.test.ts
// ============================================================================

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CoreMemoryRepository } from "../core-repository.js";
import type { MemoryScope } from "../types.js";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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

function assertEqual(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const logger = {
  info: (_msg: string) => {},
  warn: (msg: string) => { console.warn(`  [warn] ${msg}`); },
};

const scope: MemoryScope = {
  userId: "test-user",
  agentId: "test-agent",
  sessionKey: "agent:test-agent:main",
};

const otherScope: MemoryScope = {
  userId: "other-user",
  agentId: "other-agent",
  sessionKey: "agent:other-agent:main",
};

async function withRepo(fn: (repo: CoreMemoryRepository, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "core-consolidation-"));
  const repo = new CoreMemoryRepository(dir, logger, 240);
  try {
    await fn(repo, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// Tests
// ============================================================================

console.log("\nCore Consolidation Tests\n");

await test("no-op on empty store", async () => {
  await withRepo(async (repo) => {
    const result = await repo.consolidate(scope);
    assertEqual(result.merged, 0, "merged");
    assertEqual(result.deleted, 0, "deleted");
    assertEqual(result.unchanged, 0, "unchanged");
  });
});

await test("no-op when all records are unique", async () => {
  await withRepo(async (repo) => {
    await repo.upsert(scope, { category: "identity", key: "name", value: "Alice" });
    await repo.upsert(scope, { category: "identity", key: "location", value: "Beijing" });
    await repo.upsert(scope, { category: "preferences", key: "editor", value: "Neovim" });

    const result = await repo.consolidate(scope);
    assertEqual(result.merged, 0, "merged");
    assertEqual(result.deleted, 0, "deleted");
    assertEqual(result.unchanged, 3, "unchanged");

    const records = await repo.list(scope);
    assertEqual(records.length, 3, "records count after consolidation");
  });
});

await test("value dedup within same category removes near-duplicate", async () => {
  await withRepo(async (repo) => {
    await repo.upsert(scope, { category: "identity", key: "employer", value: "在字节跳动工作" });
    await repo.upsert(scope, { category: "identity", key: "company", value: "在字节跳动工作的" });

    const result = await repo.consolidate(scope, { similarityThreshold: 0.80 });
    assertEqual(result.merged, 1, "merged");
    assertEqual(result.deleted, 0, "deleted");

    const records = await repo.list(scope);
    assertEqual(records.length, 1, "should keep only one record");
  });
});

await test("value dedup keeps higher importance record", async () => {
  await withRepo(async (repo) => {
    await repo.upsert(scope, { category: "identity", key: "employer.low", value: "works at Google on search", importance: 3 });
    await repo.upsert(scope, { category: "identity", key: "employer.high", value: "works at Google on search engine", importance: 8 });

    const result = await repo.consolidate(scope, { similarityThreshold: 0.70 });
    assertEqual(result.merged, 1, "merged");

    const records = await repo.list(scope);
    assertEqual(records.length, 1, "should keep only one");
    assertEqual(records[0].importance, 8, "should keep higher importance");
  });
});

await test("dry run does not persist changes", async () => {
  await withRepo(async (repo) => {
    await repo.upsert(scope, { category: "identity", key: "employer", value: "在字节跳动工作" });
    await repo.upsert(scope, { category: "identity", key: "company", value: "在字节跳动工作的" });

    const dryResult = await repo.consolidate(scope, { dryRun: true, similarityThreshold: 0.80 });
    assertEqual(dryResult.merged, 1, "dry-run merged count");

    // Records should still exist
    const records = await repo.list(scope);
    assertEqual(records.length, 2, "records should not be deleted in dry-run");

    // Real run should now delete
    const realResult = await repo.consolidate(scope, { similarityThreshold: 0.80 });
    assertEqual(realResult.merged, 1, "real merged");
    const afterRecords = await repo.list(scope);
    assertEqual(afterRecords.length, 1, "records after real consolidation");
  });
});

await test("does not affect records from other scopes", async () => {
  await withRepo(async (repo) => {
    await repo.upsert(scope, { category: "identity", key: "employer", value: "在字节跳动工作" });
    await repo.upsert(scope, { category: "identity", key: "company", value: "在字节跳动工作的" });
    await repo.upsert(otherScope, { category: "identity", key: "employer", value: "在Google工作" });

    const result = await repo.consolidate(scope, { similarityThreshold: 0.80 });
    assertEqual(result.merged, 1, "merged in target scope");

    // Other scope should be untouched
    const otherRecords = await repo.list(otherScope);
    assertEqual(otherRecords.length, 1, "other scope records count");
    assertEqual(otherRecords[0].value, "在Google工作", "other scope value");
  });
});

await test("dissimilar values in same category are not merged", async () => {
  await withRepo(async (repo) => {
    await repo.upsert(scope, { category: "identity", key: "name", value: "Alice Johnson" });
    await repo.upsert(scope, { category: "identity", key: "location", value: "Lives in Beijing, China" });

    const result = await repo.consolidate(scope);
    assertEqual(result.merged, 0, "merged");
    assertEqual(result.unchanged, 2, "unchanged");
  });
});

await test("values across different categories are not compared", async () => {
  await withRepo(async (repo) => {
    await repo.upsert(scope, { category: "identity", key: "employer", value: "在字节跳动工作" });
    await repo.upsert(scope, { category: "general", key: "company", value: "在字节跳动工作的" });

    const result = await repo.consolidate(scope, { similarityThreshold: 0.80 });
    assertEqual(result.merged, 0, "should not merge across categories");
    assertEqual(result.unchanged, 2, "unchanged");
  });
});

await test("high threshold prevents merging moderately similar values", async () => {
  await withRepo(async (repo) => {
    await repo.upsert(scope, { category: "identity", key: "role.a", value: "Senior software engineer at Google" });
    await repo.upsert(scope, { category: "identity", key: "role.b", value: "Staff software engineer at Google" });

    // With default high threshold (0.85), these should not be merged
    const result = await repo.consolidate(scope, { similarityThreshold: 0.95 });
    assertEqual(result.merged, 0, "should not merge with strict threshold");
    assertEqual(result.unchanged, 2, "unchanged");
  });
});

// ============================================================================
// Summary
// ============================================================================

console.log("\n──────────────────");
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`Results: ${passed} passed, ${failed} failed out of ${results.length} tests`);

if (failed > 0) {
  console.log("\nFailed tests:");
  for (const r of results.filter((r) => !r.passed)) {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  }
  process.exit(1);
}
