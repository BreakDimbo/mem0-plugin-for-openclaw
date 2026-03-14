import { createRecallHook, sanitizePromptQuery, splitRecallQueries } from "../hooks/recall.js";

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

function assertEqual(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log("\nRecall Query Tests\n");

await test("sanitizePromptQuery ignores opaque sender identifiers", () => {
  const raw = JSON.stringify({
    sender_id: "om_x100b5464adbe44a8c42bfbe6c9dcd6f",
    text: "用户主要用什么笔记应用？",
  });
  assertEqual(sanitizePromptQuery(raw), "用户主要用什么笔记应用？", "should extract real query");
});

await test("sanitizePromptQuery rejects bare opaque identifiers", () => {
  assertEqual(sanitizePromptQuery("om_x100b5464adbe44a8c42bfbe6c9dcd6f"), "", "opaque id should be rejected");
});

await test("sanitizePromptQuery preserves Chinese question text", () => {
  assertEqual(sanitizePromptQuery("用户偏好喝什么饮料？"), "用户偏好喝什么饮料？", "preserve question");
});

await test("sanitizePromptQuery strips injected memory blocks and keeps the trailing question", () => {
  const raw = [
    "<core-memory>",
    "1. [preferences/foo] bar",
    "</core-memory>",
    "",
    "<relevant-memories>",
    "1. [workspace_fact] 用户的主力笔记应用是 Obsidian。",
    "</relevant-memories>",
    "",
    "请用一句中文回答：用户主要用什么笔记应用？",
  ].join("\n");
  assertEqual(
    sanitizePromptQuery(raw),
    "请用一句中文回答：用户主要用什么笔记应用？",
    "should keep only the real question after injected blocks",
  );
});

await test("splitRecallQueries keeps multi-part Chinese memory questions", () => {
  const raw = "请用三行中文回答，不要解释：1. 用户叫什么名字？2. memU embedding 现在用什么？3. 记忆系统一共有几层？";
  const parts = splitRecallQueries(raw);
  assertEqual(parts[0], "用户叫什么名字？", "question 1 extracted");
  assertEqual(parts[1], "memU embedding 现在用什么？", "question 2 extracted");
  assertEqual(parts[2], "记忆系统一共有几层？", "question 3 extracted");
});

await test("createRecallHook passes the current query into core recall", async () => {
  let seenQuery = "";
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [] } as any,
    null,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async (_scope: any, opts?: { query?: string }) => {
        seenQuery = opts?.query ?? "";
        return [];
      },
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a", requireUserId: false, requireAgentId: false },
      recall: {
        enabled: true,
        method: "rag",
        hybrid: { enabled: false, alpha: 0.5, fallbackToRag: false },
        topK: 2,
        scoreThreshold: 0.3,
        maxContextChars: 1200,
        injectionBudgetChars: 1200,
        cacheTtlMs: 1000,
        cacheMaxSize: 10,
        workspaceFallback: false,
        workspaceFallbackMaxItems: 0,
        workspaceFallbackMaxFiles: 0,
      },
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10 },
      backend: { freeText: { provider: "mem0", dualWrite: false, readFallback: "none", compareRecall: false } },
      memu: { baseUrl: "", timeoutMs: 1000, cbResetMs: 1000, healthCheckPath: "/debug" },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, dedupeThreshold: 0.8 },
      outbox: { enabled: false, concurrency: 1, batchSize: 1, maxRetries: 1, drainTimeoutMs: 1000, persistPath: "", flushIntervalMs: 1000 },
      sync: { flushToMarkdown: false, flushIntervalSec: 300, memoryFilePath: "MEMORY.md" },
    } as any,
    { info: () => {}, warn: () => {} },
    { recallTotal: 0, recallMisses: 0, recallErrors: 0, recordRecallLatency: () => {}, recordRecallCompare: () => {} } as any,
    { registerAgent: () => {} } as any,
  );

  await hook(
    {
      prompt: "请只用一句中文回答：用户的时区是什么？",
      messages: [{ role: "user", content: "用户的时区是什么？" }],
    },
    { agentId: "a", workspaceDir: "/tmp" } as any,
  );

  assertEqual(seenQuery, "用户的时区是什么？", "core recall query");
});

await test("createRecallHook keeps only strongly relevant core memories for a focused query", async () => {
  let prepend = "";
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [] } as any,
    null,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async () => [
        { id: "1", category: "identity", key: "identity.timezone", value: "用户的时区是 UTC+8。", score: 0.8 },
        { id: "2", category: "goals", key: "goals.primary", value: "用户的主目标是成为一人公司创业者。", score: 0.25 },
        { id: "3", category: "identity", key: "identity.personality", value: "用户的人格倾向是 INTJ。", score: 0.2 },
      ],
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a", requireUserId: false, requireAgentId: false },
      recall: {
        enabled: true,
        method: "rag",
        hybrid: { enabled: false, alpha: 0.5, fallbackToRag: false },
        topK: 2,
        scoreThreshold: 0.3,
        maxContextChars: 1200,
        injectionBudgetChars: 1200,
        cacheTtlMs: 1000,
        cacheMaxSize: 10,
        workspaceFallback: false,
        workspaceFallbackMaxItems: 0,
        workspaceFallbackMaxFiles: 0,
      },
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10 },
      backend: { freeText: { provider: "mem0", dualWrite: false, readFallback: "none", compareRecall: false } },
      memu: { baseUrl: "", timeoutMs: 1000, cbResetMs: 1000, healthCheckPath: "/debug" },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, dedupeThreshold: 0.8 },
      outbox: { enabled: false, concurrency: 1, batchSize: 1, maxRetries: 1, drainTimeoutMs: 1000, persistPath: "", flushIntervalMs: 1000 },
      sync: { flushToMarkdown: false, flushIntervalSec: 300, memoryFilePath: "MEMORY.md" },
    } as any,
    { info: () => {}, warn: () => {} },
    { recallTotal: 0, recallMisses: 0, recallErrors: 0, recordRecallLatency: () => {}, recordRecallCompare: () => {} } as any,
    { registerAgent: () => {} } as any,
  );

  const out = await hook(
    {
      prompt: "请只用一句中文回答：用户的时区是什么？",
      messages: [{ role: "user", content: "用户的时区是什么？" }],
    },
    { agentId: "a", workspaceDir: "/tmp" } as any,
  );
  prepend = String((out as any)?.prependContext ?? "");
  if (!prepend.includes("identity/identity.timezone")) throw new Error("timezone core fact should remain");
  if (prepend.includes("goals/goals.primary")) throw new Error("unrelated core fact should be filtered out");
});

await test("createRecallHook queries core memory per split subquery", async () => {
  const seenQueries: string[] = [];
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [] } as any,
    null,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async (_scope: any, opts?: { query?: string }) => {
        seenQueries.push(opts?.query ?? "");
        return [];
      },
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a", requireUserId: false, requireAgentId: false },
      recall: {
        enabled: true,
        method: "rag",
        hybrid: { enabled: false, alpha: 0.5, fallbackToRag: false },
        topK: 2,
        scoreThreshold: 0.3,
        maxContextChars: 1200,
        injectionBudgetChars: 1200,
        cacheTtlMs: 1000,
        cacheMaxSize: 10,
        workspaceFallback: false,
        workspaceFallbackMaxItems: 0,
        workspaceFallbackMaxFiles: 0,
      },
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10 },
      backend: { freeText: { provider: "mem0", dualWrite: false, readFallback: "none", compareRecall: false } },
      memu: { baseUrl: "", timeoutMs: 1000, cbResetMs: 1000, healthCheckPath: "/debug" },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, dedupeThreshold: 0.8 },
      outbox: { enabled: false, concurrency: 1, batchSize: 1, maxRetries: 1, drainTimeoutMs: 1000, persistPath: "", flushIntervalMs: 1000 },
      sync: { flushToMarkdown: false, flushIntervalSec: 300, memoryFilePath: "MEMORY.md" },
    } as any,
    { info: () => {}, warn: () => {} },
    { recallTotal: 0, recallMisses: 0, recallErrors: 0, recordRecallLatency: () => {}, recordRecallCompare: () => {} } as any,
    { registerAgent: () => {} } as any,
  );

  await hook(
    {
      prompt: "请用三行中文回答，不要解释：1. 用户叫什么名字？2. memU embedding 现在用什么？3. 记忆系统一共有几层？",
      messages: [{ role: "user", content: "请用三行中文回答，不要解释：1. 用户叫什么名字？2. memU embedding 现在用什么？3. 记忆系统一共有几层？" }],
    },
    { agentId: "a", workspaceDir: "/tmp" } as any,
  );

  assertEqual(seenQueries[0], "用户叫什么名字？", "core query 1");
  assertEqual(seenQueries[1], "memU embedding 现在用什么？", "core query 2");
  assertEqual(seenQueries[2], "记忆系统一共有几层？", "core query 3");
});

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
