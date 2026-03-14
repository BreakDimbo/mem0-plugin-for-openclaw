/**
 * Core memory backfill for the turning_zero agent.
 *
 * Strategy:
 *   1. List all existing core memory entries for the scope.
 *   2. Delete any stale entries whose key is NOT in the new fixture set
 *      but whose key prefix overlaps with a fixture key prefix — this
 *      removes conflicting old architecture / benchmark entries.
 *   3. UpsertMany all items from TURNING_ZERO_CORE_BACKFILL_ITEMS
 *      (updates existing keys in-place, inserts new ones).
 *   4. Print a summary.
 */

import { readFile, writeFile } from "node:fs/promises";
import { CoreMemoryRepository } from "../core-repository.js";
import { loadConfig, type MemoryScope } from "../types.js";
import { TURNING_ZERO_CORE_BACKFILL_ITEMS } from "./turning-zero-core-backfill-fixtures.js";

async function main() {
  const raw = JSON.parse(await readFile("~/.openclaw/openclaw.json", "utf-8"));
  const config = loadConfig(raw?.plugins?.entries?.["memory-mem0"]?.config ?? {});
  const logger = { info: (msg: string) => console.log(msg), warn: (msg: string) => console.warn(msg) };
  const repo = new CoreMemoryRepository(config.core.persistPath, logger, config.core.maxItemChars);

  const scope: MemoryScope = {
    userId: config.scope.userIdByAgent?.turning_zero ?? config.scope.userId,
    agentId: "turning_zero",
    sessionKey: "agent:turning_zero:main",
  };

  console.log(`Core backfill scope: user=${scope.userId} agent=${scope.agentId}`);

  // --- Step 1: list existing entries ---
  const existing = await repo.list(scope, { limit: 500 });
  console.log(`Existing core entries: ${existing.length}`);

  // --- Step 2: delete stale entries ---
  // A stale entry is one whose key shares a "namespace prefix" with a fixture
  // key but is NOT itself present in the fixture set. This removes old
  // conflicting entries (e.g. architecture layer descriptions from an old schema).
  const fixtureKeys = new Set(TURNING_ZERO_CORE_BACKFILL_ITEMS.map((item) => item.key.trim().toLowerCase()));
  const fixtureKeyPrefixes = new Set(
    TURNING_ZERO_CORE_BACKFILL_ITEMS.map((item) => {
      const parts = item.key.trim().toLowerCase().split(".");
      return parts.slice(0, 3).join(".");   // e.g. "general.memory_architecture"
    }),
  );

  let deleted = 0;
  for (const entry of existing) {
    if (fixtureKeys.has(entry.key.trim().toLowerCase())) continue;  // will be overwritten
    const entryPrefix = entry.key.trim().toLowerCase().split(".").slice(0, 3).join(".");
    if (fixtureKeyPrefixes.has(entryPrefix)) {
      const ok = await repo.delete(scope, { category: entry.category, key: entry.key });
      if (ok) {
        deleted++;
        console.log(`  Deleted stale: [${entry.category}] ${entry.key} = "${entry.value.slice(0, 60)}"`);
      }
    }
  }
  console.log(`Deleted ${deleted} stale entries.`);

  // --- Step 3: upsert all fixture items ---
  const ok = await repo.upsertMany(scope, TURNING_ZERO_CORE_BACKFILL_ITEMS);
  console.log(`UpsertMany: ${ok ? "succeeded" : "failed"} (${TURNING_ZERO_CORE_BACKFILL_ITEMS.length} items)`);

  // --- Step 4: summary ---
  const after = await repo.list(scope, { limit: 500 });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = `/tmp/turning-zero-core-backfill-${runId}.json`;
  await writeFile(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scope,
    before: existing.length,
    deleted,
    upserted: TURNING_ZERO_CORE_BACKFILL_ITEMS.length,
    after: after.length,
    items: after.map((item) => ({ category: item.category, key: item.key, value: item.value })),
  }, null, 2), "utf-8");

  console.log(`\nSummary`);
  console.log(`═══════`);
  console.log(`  before : ${existing.length}`);
  console.log(`  deleted: ${deleted}`);
  console.log(`  upserted: ${TURNING_ZERO_CORE_BACKFILL_ITEMS.length}`);
  console.log(`  after  : ${after.length}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
