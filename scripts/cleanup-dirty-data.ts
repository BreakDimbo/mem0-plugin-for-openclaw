#!/usr/bin/env npx tsx
// @ts-nocheck
// ============================================================================
// T6: Cleanup dirty Core Memory and Free-text vector store entries
// Usage:
//   npx tsx scripts/cleanup-dirty-data.ts --dry-run   (preview only)
//   npx tsx scripts/cleanup-dirty-data.ts             (execute)
// ============================================================================

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3") as typeof import("better-sqlite3").default;

const DATA_DIR = join(homedir(), ".openclaw/data/memory-mem0");
const CORE_FILE = join(DATA_DIR, "core-memory.json");
const VECTOR_DB = join(DATA_DIR, "vector-store.db");

const DRY_RUN = process.argv.includes("--dry-run");

// ── Keys to remove from Core Memory ─────────────────────────────────────────

// 1. Domain knowledge / exam study notes (22 keys)
const KNOWLEDGE_KEYS = new Set([
  "duoshen_duozheng_reform",
  "control_regulatory_planning_indicators",
  "urban_planning_law_framework",
  "regulatory_planning_approval",
  "supervision_management_2020",
  "planning_qualification_transitional",
  "practical_exam_analysis_method",
  "related_knowledge_architecture",
  "related_knowledge_road",
  "related_knowledge_municipal",
  "related_knowledge_disaster",
  "related_knowledge_economics",
  "tutored_book_city_origin",
  "tutored_book_city_nature",
  "tutored_book_index_system",
  "huaqing_2023_overview",
  "huaqing_2023_exam_structure",
  "huaqing_2023_planning_conditions",
  "huaqing_2023_permit_review",
  "huaqing_2023_analysis_framework",
  "huaqing_2023_answer_skills",
  "city_report_extractor",
]);

// 2. Test / probe artifacts
const TEST_ARTIFACT_KEYS = new Set([
  "identity.e2e_marker",
  "identity.main_agent_probe",
]);

// 3. Session-scoped contamination
const SESSION_CONTAMINATION_KEYS = new Set([
  "identity.role",          // 量化策略研究员 — session role
  "identity.persona",       // growth_hacker — agent persona
  "work.role",
  "work.directory",
  "work.goal",
  "work.focus",
  "goals.research_experiment",
  "goals.research_experiment.duration",
  "goals.research_experiment.success_criteria",
]);

// 4. Stale technical configs
const STALE_CONFIG_KEYS = new Set([
  "general.memory_memu.cb_reset_ms",
  "general.memory_memu.retrieve_timeout",
  "general.memu.retrieve.resource_search",
  "general.memu.retrieve.route_intention",
  "general.memu.retrieve.sufficiency_check",
  "general.memu_server.monthly_cost",
  "general.memu_server.retrieve_p95",
  "general.memory_architecture.layer1",
  "general.memory_architecture.layer2",
  "general.memory_architecture.layer3",
  "general.memory_architecture.layer4",
  "general.memory_architecture.layers_count",
]);

// ── Vector store IDs to remove ───────────────────────────────────────────────

// Identified by manual audit: bug report, negative findings, hallucination
const DIRTY_VECTOR_IDS = new Set([
  "07f22b84-8b74-41bf-ac04-ac70d3e22616",  // transient: "Capture system statistics bug"
  "ccd10faa-968e-4408-88e8-910424feb9fc",  // "investigating opencalw gateway" (typo + session-specific)
  "36d3b119-0dce-40dc-8056-499efb647273",  // "no information confirming reboot events today" (negative finding)
  "d0ebed45-656f-470b-8783-f622b973915d",  // hallucination: "OpenClaw is a robot gripper control framework"
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function shouldRemoveCoreItem(item: { key: string; value: string }): { remove: boolean; reason: string } {
  const key = item.key;
  // Strip category prefix for lookup (stored keys may have category.topic format)
  const bareKey = key.includes(".") ? key.split(".").slice(1).join(".") : key;

  if (KNOWLEDGE_KEYS.has(key) || KNOWLEDGE_KEYS.has(bareKey)) {
    return { remove: true, reason: "domain knowledge / exam notes" };
  }
  if (TEST_ARTIFACT_KEYS.has(key)) {
    return { remove: true, reason: "test/probe artifact" };
  }
  if (SESSION_CONTAMINATION_KEYS.has(key)) {
    return { remove: true, reason: "session-scoped contamination" };
  }
  if (STALE_CONFIG_KEYS.has(key)) {
    return { remove: true, reason: "stale technical config" };
  }
  return { remove: false, reason: "" };
}

// ── Core Memory cleanup ───────────────────────────────────────────────────────

async function cleanupCoreMemory(): Promise<void> {
  const raw = await readFile(CORE_FILE, "utf-8");
  const data = JSON.parse(raw) as { version: number; items: Array<{ id: string; key: string; value: string; category?: string }> };
  const before = data.items.length;

  // Dedup: keep newest by key+scope for any duplicates
  type ScopedRecord = { key: string; value: string; updatedAt?: number; id: string; scope: { userId: string; agentId: string; tenantId?: string } };
  const seenMap = new Map<string, ScopedRecord>();
  for (const item of data.items as ScopedRecord[]) {
    const dedupeKey = `${item.scope.userId}\0${item.scope.agentId}\0${item.scope.tenantId ?? ""}\0${item.key}`;
    const existing = seenMap.get(dedupeKey);
    if (!existing || (item.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
      seenMap.set(dedupeKey, item);
    }
  }
  const deduped = Array.from(seenMap.values());
  const dedupedCount = before - deduped.length;

  // Filter dirty items
  const kept: typeof data.items = [];
  const removed: Array<{ key: string; reason: string }> = [];

  for (const item of deduped as typeof data.items) {
    const { remove, reason } = shouldRemoveCoreItem(item);
    if (remove) {
      removed.push({ key: item.key, reason });
    } else {
      kept.push(item);
    }
  }

  console.log(`\n── Core Memory ─────────────────────────────────────────`);
  console.log(`  Before: ${before} items`);
  if (dedupedCount > 0) {
    console.log(`  Deduped: ${dedupedCount} duplicate(s) removed`);
  }
  console.log(`  Removing ${removed.length} dirty items:`);
  for (const r of removed) {
    console.log(`    [-] ${r.key}  (${r.reason})`);
  }
  console.log(`  After: ${kept.length} items`);

  if (!DRY_RUN) {
    // Backup first
    await copyFile(CORE_FILE, CORE_FILE + ".bak");
    await writeFile(CORE_FILE, JSON.stringify({ version: 1, items: kept }, null, 2), "utf-8");
    console.log(`  ✓ Written (backup: core-memory.json.bak)`);
  }
}

// ── Vector store cleanup ─────────────────────────────────────────────────────

function cleanupVectorStore(): void {
  console.log(`\n── Free-text Vector Store ─────────────────────────────`);

  let db: ReturnType<typeof Database>;
  try {
    db = new Database(VECTOR_DB);
  } catch {
    // Try without native module — fall back to manual SQL file approach
    console.log(`  ⚠ better-sqlite3 not available, showing IDs to remove manually:`);
    for (const id of DIRTY_VECTOR_IDS) {
      console.log(`    [-] ${id}`);
    }
    console.log(`  Manual SQL: DELETE FROM vectors WHERE id IN ('${Array.from(DIRTY_VECTOR_IDS).join("','")}');`);
    return;
  }

  const placeholders = Array.from(DIRTY_VECTOR_IDS).map(() => "?").join(", ");
  const existing = db.prepare(`SELECT id, payload FROM vectors WHERE id IN (${placeholders})`).all(...DIRTY_VECTOR_IDS) as { id: string; payload: string }[];

  console.log(`  Removing ${existing.length} dirty vectors:`);
  for (const row of existing) {
    let preview = row.payload;
    try {
      const p = JSON.parse(row.payload);
      preview = (p.data ?? p.text ?? JSON.stringify(p)).toString().slice(0, 80);
    } catch { /**/ }
    console.log(`    [-] ${row.id}`);
    console.log(`        ${preview}`);
  }

  const notFound = Array.from(DIRTY_VECTOR_IDS).filter(id => !existing.find(r => r.id === id));
  if (notFound.length > 0) {
    console.log(`  Already absent (${notFound.length}): ${notFound.join(", ")}`);
  }

  if (!DRY_RUN && existing.length > 0) {
    db.prepare(`DELETE FROM vectors WHERE id IN (${placeholders})`).run(...DIRTY_VECTOR_IDS);
    console.log(`  ✓ ${existing.length} vector(s) deleted`);
  }

  db.close();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Memory Quality Cleanup`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "EXECUTE"}`);
  console.log(`Data dir: ${DATA_DIR}`);

  await cleanupCoreMemory();
  cleanupVectorStore();

  console.log(`\n${DRY_RUN ? "Dry run complete. Re-run without --dry-run to apply." : "Cleanup complete."}`);
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
