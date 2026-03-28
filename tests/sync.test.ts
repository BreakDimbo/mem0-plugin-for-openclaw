// ============================================================================
// Tests: sync.ts — MarkdownSync public API and core behaviour
// Run with: npx tsx tests/sync.test.ts
// ============================================================================

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MarkdownSync } from "../sync.js";
import type { MemuPluginConfig, MemoryScope } from "../types.js";
import type { CoreMemoryRecord } from "../types.js";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpDir: string;

async function setup(): Promise<void> {
  tmpDir = await mkdtemp(join(tmpdir(), "sync-test-"));
}

async function teardown(): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true });
}

const noop = { info: () => {}, warn: () => {} };

function makeConfig(overrides: Partial<MemuPluginConfig["sync"]> = {}, memFilePath?: string): MemuPluginConfig {
  return {
    scope: { userId: "test-user", agentId: "test-agent", sessionKey: "test-session" },
    recall: { enabled: true, topK: 5, maxChars: 2000, cacheMaxSize: 100, cacheTtlMs: 60_000, maxContextTurns: 2 },
    capture: {
      enabled: true,
      debounceMs: 0,
      minMessageLength: 10,
      maxCandidates: 5,
      minCandidates: 1,
      skipSystemMessages: true,
      captureAssistantMessages: false,
    },
    outbox: {
      maxRetries: 3,
      retryDelayMs: 1000,
      drainTimeoutMs: 5000,
      persistPath: join(tmpDir, "outbox.json"),
      deadLetterPath: join(tmpDir, "dead-letter.json"),
    },
    sync: {
      enabled: true,
      memoryFilePath: memFilePath ?? join(tmpDir, "MEMORY.md"),
      intervalMs: 3_600_000,
      ...overrides,
    },
    core: {
      enabled: true,
      topK: 20,
      maxRecords: 100,
      storagePath: join(tmpDir, "core.json"),
      consolidation: {
        enabled: false,
        intervalMs: 3_600_000,
        statePath: join(tmpDir, "consolidation-state.json"),
        similarityThreshold: 0.92,
        boundaryLow: 0.25,
        boundaryHigh: 0.65,
        maxBatchSize: 50,
        schedule: {
          daily:   { enabled: false, hourOfDay: 2 },
          weekly:  { enabled: false, hourOfDay: 3 },
          monthly: { enabled: false, hourOfDay: 4 },
        },
        llm: { enabled: false, apiBase: "", apiKey: "", model: "", maxBatchSize: 10, timeoutMs: 30_000 },
      },
    },
    llmGate: {
      enabled: false,
      apiKey: "",
      apiBase: "",
      model: "",
      maxTokensPerBatch: 1000,
      timeoutMs: 30_000,
    },
  } as unknown as MemuPluginConfig;
}

function makeScopeResolver(scope: MemoryScope) {
  return { resolveRuntimeScope: () => scope };
}

function makeCoreRepo(records: CoreMemoryRecord[] = []) {
  return { list: async () => records };
}

function makePrimaryBackend(items: Array<{ text: string; score?: number }> = []) {
  return {
    provider: "test-backend",
    healthCheck: async () => ({ healthy: true, provider: "test-backend" }),
    search: async () => items.map((i) => ({ ...i, score: i.score ?? 0.9 })),
  };
}

const baseScope: MemoryScope = { userId: "u1", agentId: "agent1", sessionKey: "s1" };

// ── registerAgent ─────────────────────────────────────────────────────────────

console.log("\nMarkdownSync Tests\n");

await setup();

await test("registerAgent: records workspace dir", async () => {
  const config = makeConfig();
  const sync = new MarkdownSync(
    makePrimaryBackend() as any,
    makeScopeResolver(baseScope),
    makeCoreRepo() as any,
    config,
    noop,
  );
  sync.registerAgent("agent1", tmpDir, { schedule: false });
  // Verify by forcing sync — should succeed (not skip due to unknown workspace)
  const result = await sync.forceSync("agent1");
  assert(result.syncedAgents.includes("agent1"), "agent1 synced after registration");
});

await test("registerAgent with schedule=false: does not trigger debounce", async () => {
  const config = makeConfig();
  let scheduleCallCount = 0;
  const sync = new MarkdownSync(
    makePrimaryBackend() as any,
    makeScopeResolver(baseScope),
    makeCoreRepo() as any,
    config,
    noop,
  );
  // Monkeypatch scheduleSync to count calls
  const originalSchedule = sync.scheduleSync.bind(sync);
  (sync as any).scheduleSync = (agentId?: string) => {
    scheduleCallCount++;
    return originalSchedule(agentId);
  };
  sync.registerAgent("agent-no-sched", tmpDir, { schedule: false });
  assertEqual(scheduleCallCount, 0, "scheduleSync not called when schedule=false");
});

// ── forceSync ─────────────────────────────────────────────────────────────────

await test("forceSync with specific agentId: returns that agent in syncedAgents", async () => {
  const config = makeConfig({}, join(tmpDir, "force-test.md"));
  const sync = new MarkdownSync(
    makePrimaryBackend() as any,
    makeScopeResolver(baseScope),
    makeCoreRepo() as any,
    config,
    noop,
  );
  sync.registerAgent("agentX", tmpDir, { schedule: false });
  const result = await sync.forceSync("agentX");
  assertEqual(result.syncedAgents.length, 1, "one agent returned");
  assertEqual(result.syncedAgents[0], "agentX", "correct agentId returned");
});

await test("forceSync with no agentId: syncs all registered agents", async () => {
  const config = makeConfig({}, join(tmpDir, "MEMORY-multi-{agentId}.md"));
  const sync = new MarkdownSync(
    makePrimaryBackend() as any,
    makeScopeResolver(baseScope),
    makeCoreRepo() as any,
    config,
    noop,
  );
  const workspace2 = join(tmpDir, "ws2");
  sync.registerAgent("agentA", tmpDir, { schedule: false });
  sync.registerAgent("agentB", workspace2, { schedule: false });
  const result = await sync.forceSync();
  assert(result.syncedAgents.includes("agentA"), "agentA in result");
  assert(result.syncedAgents.includes("agentB"), "agentB in result");
});

await test("forceSync with no agents registered: returns empty syncedAgents", async () => {
  const config = makeConfig({}, join(tmpDir, "MEMORY-empty.md"));
  const sync = new MarkdownSync(
    makePrimaryBackend() as any,
    makeScopeResolver(baseScope),
    makeCoreRepo() as any,
    config,
    noop,
  );
  const result = await sync.forceSync();
  assertEqual(result.syncedAgents.length, 0, "no agents synced");
});

// ── Markdown file output ──────────────────────────────────────────────────────

await test("forceSync writes MEMORY.md with generated block markers", async () => {
  const filePath = join(tmpDir, "markers-test.md");
  const config = makeConfig({}, filePath);
  const sync = new MarkdownSync(
    makePrimaryBackend() as any,
    makeScopeResolver(baseScope),
    makeCoreRepo() as any,
    config,
    noop,
  );
  sync.registerAgent("agentM", tmpDir, { schedule: false });
  await sync.forceSync("agentM");

  const content = await readFile(filePath, "utf-8");
  assert(content.includes("<!-- memory-mem0:start -->"), "start marker present");
  assert(content.includes("<!-- memory-mem0:end -->"), "end marker present");
  assert(content.includes("<!-- memory-mem0:generated -->"), "generated header present");
});

await test("forceSync writes core memories into sections", async () => {
  const filePath = join(tmpDir, "core-sections-test.md");
  const config = makeConfig({}, filePath);
  const coreRecords: CoreMemoryRecord[] = [
    { id: "r1", category: "identity", key: "name", value: "Alice", source: "test", score: 1 } as CoreMemoryRecord,
    { id: "r2", category: "preferences", key: "editor", value: "vim", source: "test", score: 1 } as CoreMemoryRecord,
  ];
  const sync = new MarkdownSync(
    makePrimaryBackend() as any,
    makeScopeResolver(baseScope),
    makeCoreRepo(coreRecords) as any,
    config,
    noop,
  );
  sync.registerAgent("agentCore", tmpDir, { schedule: false });
  await sync.forceSync("agentCore");

  const content = await readFile(filePath, "utf-8");
  assert(content.includes("## Core Identity"), "identity section present");
  assert(content.includes("Alice"), "identity value written");
  assert(content.includes("## Core Preferences"), "preferences section present");
  assert(content.includes("vim"), "preferences value written");
});

await test("forceSync: re-sync replaces generated block, preserves custom content", async () => {
  const filePath = join(tmpDir, "merge-test.md");
  const config = makeConfig({}, filePath);
  const { writeFile } = await import("node:fs/promises");
  // Write initial file with custom content
  await writeFile(filePath, "<!-- memory-mem0:start -->\n<!-- memory-mem0:generated -->\n## Core General\n\n- old\n\n<!-- memory-mem0:end -->\n\nMy custom notes here.\n", "utf-8");

  const sync = new MarkdownSync(
    makePrimaryBackend() as any,
    makeScopeResolver(baseScope),
    makeCoreRepo() as any,
    config,
    noop,
  );
  sync.registerAgent("agentMerge", tmpDir, { schedule: false });
  await sync.forceSync("agentMerge");

  const content = await readFile(filePath, "utf-8");
  assert(content.includes("My custom notes here."), "custom content preserved after re-sync");
  // There should only be one generated block
  const startCount = (content.match(/<!-- memory-mem0:start -->/g) ?? []).length;
  assertEqual(startCount, 1, "only one generated block start marker");
});

// ── Stats getters ─────────────────────────────────────────────────────────────

await test("syncCount increments after each forceSync call", async () => {
  const config = makeConfig({}, join(tmpDir, "stats-test.md"));
  const sync = new MarkdownSync(
    makePrimaryBackend() as any,
    makeScopeResolver(baseScope),
    makeCoreRepo() as any,
    config,
    noop,
  );
  sync.registerAgent("agentStats", tmpDir, { schedule: false });
  assertEqual(sync.syncCount, 0, "starts at 0");
  await sync.forceSync("agentStats");
  assertEqual(sync.syncCount, 1, "increments to 1 after first sync");
  await sync.forceSync("agentStats");
  assertEqual(sync.syncCount, 2, "increments to 2 after second sync");
});

await test("lastSyncAt updates after forceSync", async () => {
  const config = makeConfig({}, join(tmpDir, "lastsync-test.md"));
  const sync = new MarkdownSync(
    makePrimaryBackend() as any,
    makeScopeResolver(baseScope),
    makeCoreRepo() as any,
    config,
    noop,
  );
  sync.registerAgent("agentLast", tmpDir, { schedule: false });
  assertEqual(sync.lastSyncAt, 0, "starts at 0");
  const before = Date.now();
  await sync.forceSync("agentLast");
  const after = Date.now();
  assert(sync.lastSyncAt >= before, "lastSyncAt >= before");
  assert(sync.lastSyncAt <= after, "lastSyncAt <= after");
});

await test("totalWritten reflects core + recall items written", async () => {
  const config = makeConfig({}, join(tmpDir, "totalwritten-test.md"));
  const coreRecords: CoreMemoryRecord[] = [
    { id: "tw1", category: "identity", key: "name", value: "Bob", source: "test", score: 1 } as CoreMemoryRecord,
    { id: "tw2", category: "preferences", key: "lang", value: "TypeScript", source: "test", score: 1 } as CoreMemoryRecord,
  ];
  const recallItems = [
    { text: "Bob prefers TypeScript for backend work", score: 0.95, metadata: { quality: "durable" } },
  ];
  const sync = new MarkdownSync(
    makePrimaryBackend(recallItems) as any,
    makeScopeResolver(baseScope),
    makeCoreRepo(coreRecords) as any,
    config,
    noop,
  );
  sync.registerAgent("agentTW", tmpDir, { schedule: false });
  await sync.forceSync("agentTW");
  // 2 core + up to 1 recall item (passes noisy filter)
  assert(sync.totalWritten >= 2, "totalWritten accounts for core items");
});

// ── Path traversal guard ──────────────────────────────────────────────────────

await test("relative memoryFilePath outside workspace is rejected (path traversal guard)", async () => {
  // Use "../evil.md" as relative path — should be blocked
  const config = makeConfig({}, "../evil.md");
  const logs: string[] = [];
  const logger = { info: () => {}, warn: (m: string) => { logs.push(m); } };
  const sync = new MarkdownSync(
    makePrimaryBackend() as any,
    makeScopeResolver(baseScope),
    makeCoreRepo() as any,
    config,
    logger,
  );
  sync.registerAgent("agentEvil", tmpDir, { schedule: false });
  await sync.forceSync("agentEvil");
  // resolveFilePath should return null → sync logs a skip warning
  assert(logs.some((l) => l.includes("workspace is unknown") || l.includes("skipped")), "traversal attempt logs a skip");
});

// Cleanup
await teardown();

// Summary
console.log();
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
