// ============================================================================
// Dreaming E2E Test: Recall hook → Signal store → Deep/REM phases → Promotion
// Exercises the full dreaming pipeline with real components, only FreeTextBackend mocked.
// Run with: npx tsx tests/dreaming-e2e.test.ts
// ============================================================================

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { RecallSignalStore } from "../consolidation/signal-store.js";
import { PhaseSignalStore } from "../consolidation/phase-signal-store.js";
import { ConsolidationRunner } from "../consolidation/runner.js";
import { CoreMemoryRepository } from "../core-repository.js";
import { createRecallHook } from "../hooks/recall.js";
import { LRUCache } from "../cache.js";
import { InboundMessageCache } from "../inbound-cache.js";
import { Metrics } from "../metrics.js";
import { MarkdownSync } from "../sync.js";
import { loadConfig, buildScope, type MemoryScope, type ConversationMessage } from "../types.js";
import type { FreeTextBackend, FreeTextBackendStatus, FreeTextSearchOptions, FreeTextStoreOptions, FreeTextForgetOptions } from "../backends/free-text/base.js";
import type { MemuMemoryRecord } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function assertEqual<T>(a: T, b: T, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const DEBUG = process.env.E2E_DEBUG === "1";
const logger = {
  info: (msg: string) => { if (DEBUG) console.log("  [INFO]", msg); },
  warn: (msg: string) => { if (DEBUG) console.log("  [WARN]", msg); },
  error: (msg: string) => { if (DEBUG) console.log("  [ERROR]", msg); },
};

// ── StableIdFreeTextBackend ──────────────────────────────────────────────────

function getTextFromMessages(messages: ConversationMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return lastUser?.content ?? "";
}

type StoredFreeText = { messages: ConversationMessage[]; scope: MemoryScope; metadata?: Record<string, unknown> };

class StableIdFreeTextBackend implements FreeTextBackend {
  readonly provider = "stable-id-test";
  items: StoredFreeText[] = [];

  async healthCheck(): Promise<FreeTextBackendStatus> {
    return { provider: this.provider, healthy: true };
  }

  async store(messages: ConversationMessage[], scope: MemoryScope, options?: FreeTextStoreOptions): Promise<boolean> {
    this.items.push({ messages, scope, metadata: options?.metadata });
    return true;
  }

  async search(query: string, scope: MemoryScope, _options?: FreeTextSearchOptions): Promise<MemuMemoryRecord[]> {
    const q = query.toLowerCase();
    return this.items
      .filter((item) => item.scope.userId === scope.userId && item.scope.agentId === scope.agentId)
      .filter((item) => {
        const text = getTextFromMessages(item.messages).toLowerCase();
        return text.includes(q);
      })
      .map((item) => ({
        id: `ft-${this.items.indexOf(item)}`,
        text: getTextFromMessages(item.messages),
        category: (item.metadata?.memory_kind as string) ?? "general",
        score: 0.8,
        source: "memu_item" as const,
        scope: item.scope,
        metadata: item.metadata,
      }));
  }

  async list(scope: MemoryScope, _options?: { limit?: number }): Promise<MemuMemoryRecord[]> {
    return this.items
      .filter((item) => item.scope.userId === scope.userId && item.scope.agentId === scope.agentId)
      .map((item) => ({
        id: `ft-${this.items.indexOf(item)}`,
        text: getTextFromMessages(item.messages),
        category: "general",
        source: "memu_item" as const,
        scope: item.scope,
      }));
  }

  async forget(_scope: MemoryScope, _options?: FreeTextForgetOptions): Promise<{ purged_categories: number; purged_items: number; purged_resources: number } | null> {
    return { purged_categories: 0, purged_items: 0, purged_resources: 0 };
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function testRecallHookRecordsSignals(): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "dreaming-e2e-"));
  try {
    const scope = buildScope({ userId: "u1", agentId: "agent1" });
    const dataDir = join(tmpDir, "data");
    const config = loadConfig({ dataDir, scope: { userId: "u1", agentId: "agent1" }, dreaming: { enabled: true } });

    const backend = new StableIdFreeTextBackend();
    await backend.store([{ role: "user", content: "My favorite color is blue" }], scope);

    const coreRepo = new CoreMemoryRepository(dataDir, logger, 300);
    const cache = new LRUCache<MemuMemoryRecord[]>(10, 60_000);
    const inbound = new InboundMessageCache("", 2 * 60_000, 10);
    const metrics = new Metrics();
    const sync = new MarkdownSync(
      backend,
      { resolveRuntimeScope: () => scope },
      coreRepo,
      config,
      logger,
    );

    const signalStore = new RecallSignalStore(config.dreaming.signalStorePath, config.dreaming, logger);

    const hook = createRecallHook(
      backend,
      { resolveRuntimeScope: () => scope },
      coreRepo,
      cache,
      inbound,
      config,
      logger,
      metrics,
      sync,
      undefined,
      signalStore,
    );

    await hook({ messages: [{ role: "user", content: "favorite color" }] }, scope);

    const entries = signalStore.getAll();
    assertEqual(entries.length, 1, "should have 1 recall signal");
    assertEqual(entries[0].key, "ft-0", "signal key should match free-text memory id");
    assertEqual(entries[0].layer, "free-text", "layer should be free-text");
    assertEqual(entries[0].recallCount, 1, "recallCount should be 1");
    assertEqual(entries[0].queryHashes.length, 1, "should have 1 query hash");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function testDreamingCycleDryRun(): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "dreaming-e2e-"));
  try {
    const scope = buildScope({ userId: "u1", agentId: "agent1" });
    const dataDir = join(tmpDir, "data");
    const config = loadConfig({ dataDir, scope: { userId: "u1", agentId: "agent1" }, dreaming: { enabled: true } });

    const backend = new StableIdFreeTextBackend();
    await backend.store([{ role: "user", content: "My favorite color is blue" }], scope);

    const coreRepo = new CoreMemoryRepository(dataDir, logger, 300);
    const signalStore = new RecallSignalStore(config.dreaming.signalStorePath, config.dreaming, logger);
    const phaseSignalStore = new PhaseSignalStore(config.dreaming.phaseSignalStorePath);

    // Seed a high-value signal entry (10 recalls across 5 distinct queries)
    for (let i = 0; i < 10; i++) {
      signalStore.recordRecall({
        key: "ft-0",
        layer: "free-text",
        snippet: "My favorite color is blue",
        queryHash: `q${i % 5}`,
        relevanceScore: 0.8,
        conceptTags: ["general"],
      });
    }
    // Add a light phase boost to push score over threshold
    phaseSignalStore.recordLightHit("ft-0");

    await signalStore.flush();
    await phaseSignalStore.flush();

    const runner = new ConsolidationRunner(coreRepo, config.core.consolidation, logger, backend, {
      signalStore,
      phaseSignalStore,
      dreamingConfig: config.dreaming,
    });
    runner.setPauseResumeFlush(() => {}, () => {});

    const report = await runner.runDreaming(scope, true);

    assert(report.promotions.length > 0, "dryRun should compute promotions");
    assertEqual(report.promotions[0].sourceKey, "ft-0", "promotion source should be ft-0");

    const coreList = await coreRepo.list(scope);
    assertEqual(coreList.length, 0, "dryRun should NOT write to core repo");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function testDreamingCycleLiveRun(): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "dreaming-e2e-"));
  try {
    const scope = buildScope({ userId: "u1", agentId: "agent1" });
    const dataDir = join(tmpDir, "data");
    const config = loadConfig({ dataDir, scope: { userId: "u1", agentId: "agent1" }, dreaming: { enabled: true } });

    const backend = new StableIdFreeTextBackend();
    await backend.store([{ role: "user", content: "My favorite color is blue" }], scope);

    const coreRepo = new CoreMemoryRepository(dataDir, logger, 300);
    const signalStore = new RecallSignalStore(config.dreaming.signalStorePath, config.dreaming, logger);
    const phaseSignalStore = new PhaseSignalStore(config.dreaming.phaseSignalStorePath);

    for (let i = 0; i < 10; i++) {
      signalStore.recordRecall({
        key: "ft-0",
        layer: "free-text",
        snippet: "My favorite color is blue",
        queryHash: `q${i % 5}`,
        relevanceScore: 0.8,
        conceptTags: ["general"],
      });
    }
    phaseSignalStore.recordLightHit("ft-0");

    await signalStore.flush();
    await phaseSignalStore.flush();

    const runner = new ConsolidationRunner(coreRepo, config.core.consolidation, logger, backend, {
      signalStore,
      phaseSignalStore,
      dreamingConfig: config.dreaming,
    });
    runner.setPauseResumeFlush(() => {}, () => {});

    const report = await runner.runDreaming(scope, false);

    assertEqual(report.promotions.length, 1, "liveRun should promote 1 memory");

    const coreList = await coreRepo.list(scope);
    assertEqual(coreList.length, 1, "core repo should have 1 promoted memory");
    assert(coreList[0].key.startsWith("dreaming.ft-0"), `promoted key should start with dreaming.ft-0, got ${coreList[0].key}`);
    assertEqual(coreList[0].source, "dreaming", "source should be dreaming");
    assertEqual(coreList[0].value, "My favorite color is blue", "value should match memory text");

    const entry = signalStore.get("ft-0");
    if (!entry) throw new Error("signal entry should still exist");
    assert(entry.promotedAt !== undefined, "signal entry should be marked promoted");

    // Verify persistence files were created
    await signalStore.flush();
    await phaseSignalStore.flush();
    const signalFile = await readFile(config.dreaming.signalStorePath, "utf-8");
    const phaseFile = await readFile(config.dreaming.phaseSignalStorePath, "utf-8");
    assert(signalFile.includes("ft-0"), "signal store file should persist ft-0");
    assert(phaseFile.includes("ft-0"), "phase signal store file should persist ft-0");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function testDreamingIdempotency(): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "dreaming-e2e-"));
  try {
    const scope = buildScope({ userId: "u1", agentId: "agent1" });
    const dataDir = join(tmpDir, "data");
    const config = loadConfig({ dataDir, scope: { userId: "u1", agentId: "agent1" }, dreaming: { enabled: true } });

    const backend = new StableIdFreeTextBackend();
    await backend.store([{ role: "user", content: "My favorite color is blue" }], scope);

    const coreRepo = new CoreMemoryRepository(dataDir, logger, 300);
    const signalStore = new RecallSignalStore(config.dreaming.signalStorePath, config.dreaming, logger);
    const phaseSignalStore = new PhaseSignalStore(config.dreaming.phaseSignalStorePath);

    for (let i = 0; i < 10; i++) {
      signalStore.recordRecall({
        key: "ft-0",
        layer: "free-text",
        snippet: "My favorite color is blue",
        queryHash: `q${i % 5}`,
        relevanceScore: 0.8,
        conceptTags: ["general"],
      });
    }
    phaseSignalStore.recordLightHit("ft-0");

    await signalStore.flush();
    await phaseSignalStore.flush();

    const runner = new ConsolidationRunner(coreRepo, config.core.consolidation, logger, backend, {
      signalStore,
      phaseSignalStore,
      dreamingConfig: config.dreaming,
    });
    runner.setPauseResumeFlush(() => {}, () => {});

    const r1 = await runner.runDreaming(scope, false);
    assertEqual(r1.promotions.length, 1, "first run should promote 1 memory");

    const r2 = await runner.runDreaming(scope, false);
    assertEqual(r2.promotions.length, 0, "second run should not re-promote same memory");

    const coreList = await coreRepo.list(scope);
    assertEqual(coreList.length, 1, "core repo should still have exactly 1 memory");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Running Dreaming E2E tests...\n");

  await test("recall hook records signals into signal store", testRecallHookRecordsSignals);
  await test("dreaming dryRun computes promotions without writing core", testDreamingCycleDryRun);
  await test("dreaming liveRun promotes memory and persists state", testDreamingCycleLiveRun);
  await test("dreaming liveRun is idempotent (no duplicate promotions)", testDreamingIdempotency);

  console.log("");
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
