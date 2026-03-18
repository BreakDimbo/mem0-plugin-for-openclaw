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

await test("sanitizePromptQuery strips leading timestamp and system wrappers", () => {
  const raw = "[Sat 2026-03-14 18:40 GMT+8] 请只用一句中文回答：用户的时区是什么？";
  assertEqual(
    sanitizePromptQuery(raw),
    "请只用一句中文回答：用户的时区是什么？",
    "should remove leading timestamp wrapper",
  );
});

await test("sanitizePromptQuery strips system prefixes from delivery wrappers", () => {
  const raw = "System: Feishu[turning_zero] DM | DD\n请只用一句中文回答：用户主要深耕什么技术领域？";
  assertEqual(
    sanitizePromptQuery(raw),
    "请只用一句中文回答：用户主要深耕什么技术领域？",
    "should keep only the actual question",
  );
});

await test("sanitizePromptQuery strips stacked system and timestamp wrappers", () => {
  const raw = "System: [Sat 2026-03-14 18:48 GMT+8] 请只用一句中文回答：用户的时区是什么？";
  assertEqual(
    sanitizePromptQuery(raw),
    "请只用一句中文回答：用户的时区是什么？",
    "should strip nested wrappers before the actual question",
  );
});

await test("sanitizePromptQuery reduces timestamped low-information text to its bare content", () => {
  const raw = "[Sat 2026-03-14 19:22 GMT+8] 你好";
  assertEqual(
    sanitizePromptQuery(raw),
    "你好",
    "should strip the leading timestamp from low-information text",
  );
});

await test("sanitizePromptQuery strips user-prefixed timestamped low-information text", () => {
  const raw = "user: [Sat 2026-03-14 19:22 GMT+8] 你好";
  assertEqual(
    sanitizePromptQuery(raw),
    "你好",
    "should strip user prefix and timestamp wrapper",
  );
});

await test("sanitizePromptQuery strips current-time wrappers before low-information text", () => {
  const raw = "Current time: Saturday, March 14th, 2026 — 7:22 PM (Asia/Singapore) / 2026-03-14 11:22 UTC\n[Sat 2026-03-14 19:22 GMT+8] 你好";
  assertEqual(
    sanitizePromptQuery(raw),
    "你好",
    "should strip current-time envelope before low-information text",
  );
});

await test("splitRecallQueries keeps multi-part Chinese memory questions", () => {
  const raw = "请用三行中文回答，不要解释：1. 用户叫什么名字？2. memU embedding 现在用什么？3. 记忆系统一共有几层？";
  const parts = splitRecallQueries(raw);
  assertEqual(parts[0], "用户叫什么名字？", "question 1 extracted");
  assertEqual(parts[1], "memU embedding 现在用什么？", "question 2 extracted");
  assertEqual(parts[2], "记忆系统一共有几层？", "question 3 extracted");
});

await test("createRecallHook loads session core cache once and reranks against current query", async () => {
  let listCalls = 0;
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [] } as any,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async () => {
        listCalls += 1;
        return [
          { id: "core-tz", category: "identity", key: "identity.timezone", value: "用户的时区是 UTC+8。", score: 0.2 },
          { id: "core-goal", category: "goals", key: "goals.primary", value: "用户的主目标是成为一人公司创业者。", score: 0.2 },
        ];
      },
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a" },
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
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10, alwaysInjectTiers: ["profile", "general"], retrievalOnlyTiers: ["technical"], maxAlwaysInjectChars: 600 },
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, maxConversationTurns: 1, dedupeThreshold: 0.8 },
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
    { agentId: "a", workspaceDir: "/tmp", sessionId: "s-core-query" } as any,
  );

  await hook(
    {
      prompt: "请只用一句中文回答：用户的主目标是什么？",
      messages: [{ role: "user", content: "用户的主目标是什么？" }],
    },
    { agentId: "a", workspaceDir: "/tmp", sessionId: "s-core-query" } as any,
  );

  assertEqual(listCalls, 1, "core repo should be loaded once for the session");
});

await test("createRecallHook always-injects profile-tier facts and scores technical-tier", async () => {
  let prepend = "";
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [] } as any,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async () => [
        { id: "1", category: "identity", key: "identity.timezone", value: "用户的时区是 UTC+8。", score: 0.8 },
        { id: "2", category: "goals", key: "goals.primary", value: "用户的主目标是成为一人公司创业者。", score: 0.25 },
        { id: "3", category: "technical", key: "technical.model", value: "smart-router 分类器现在的模型是 gemini。", score: 0.1 },
      ],
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a" },
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
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10, alwaysInjectTiers: ["profile", "general"], retrievalOnlyTiers: ["technical"], maxAlwaysInjectChars: 600 },
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, maxConversationTurns: 1, dedupeThreshold: 0.8 },
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
    { agentId: "a", workspaceDir: "/tmp", sessionId: "s-suppress-core" } as any,
  );
  prepend = String((out as any)?.prependContext ?? "");
  // Profile-tier facts (identity + goals) are always injected
  if (!prepend.includes("identity/timezone")) throw new Error("timezone core fact should remain (profile tier)");
  if (!prepend.includes("goals/primary")) throw new Error("goals fact should be always-injected (profile tier)");
  // Technical-tier fact should NOT appear when irrelevant to timezone query
  if (prepend.includes("technical/model")) throw new Error("irrelevant technical-tier fact should be filtered out");
});

await test("createRecallHook prefers the stronger lexical core match for a focused query", async () => {
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [] } as any,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async () => [
        { id: "a", category: "preferences", key: "preferences.preference_a", value: "沟通风格偏好平静、专业、直击要害。", score: 0.2 },
        { id: "b", category: "preferences", key: "preferences.preference_b", value: "用户偏好异步沟通。", score: 0.2 },
        { id: "c", category: "preferences", key: "preferences.preference_c", value: "表达方式偏好金字塔结构。", score: 0.2 },
      ],
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a" },
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
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10, alwaysInjectTiers: ["profile", "general"], retrievalOnlyTiers: ["technical"], maxAlwaysInjectChars: 600 },
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, maxConversationTurns: 1, dedupeThreshold: 0.8 },
      outbox: { enabled: false, concurrency: 1, batchSize: 1, maxRetries: 1, drainTimeoutMs: 1000, persistPath: "", flushIntervalMs: 1000 },
      sync: { flushToMarkdown: false, flushIntervalSec: 300, memoryFilePath: "MEMORY.md" },
    } as any,
    { info: () => {}, warn: () => {} },
    { recallTotal: 0, recallMisses: 0, recallErrors: 0, recordRecallLatency: () => {}, recordRecallCompare: () => {} } as any,
    { registerAgent: () => {} } as any,
  );

  const out = await hook(
    {
      prompt: "请只用一句中文回答：用户偏好什么沟通方式？",
      messages: [{ role: "user", content: "用户偏好什么沟通方式？" }],
    },
    { agentId: "a", workspaceDir: "/tmp", sessionId: "s-comm-mode" } as any,
  );

  const prepend = String((out as any)?.prependContext ?? "");
  if (!prepend.includes("用户偏好异步沟通")) throw new Error("the more directly matching core fact should be injected");
});

await test("createRecallHook always-injects profile tier even when not directly matching query", async () => {
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [] } as any,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async () => [
        { id: "neighbor", category: "goals", key: "goals.generic", value: "用户有一个长期目标。", score: 0.2 },
        { id: "direct", category: "identity", key: "identity.fact", value: "用户的时区是 UTC+8。", score: 0.2 },
      ],
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a" },
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
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10, alwaysInjectTiers: ["profile", "general"], retrievalOnlyTiers: ["technical"], maxAlwaysInjectChars: 600 },
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, maxConversationTurns: 1, dedupeThreshold: 0.8 },
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
    { agentId: "a", workspaceDir: "/tmp", sessionId: "s-timezone" } as any,
  );
  const prepend = String((out as any)?.prependContext ?? "");
  // Both are profile tier → both always-injected
  if (!prepend.includes("用户的时区是 UTC+8")) throw new Error("direct lexical fact should be selected");
  if (!prepend.includes("用户有一个长期目标")) throw new Error("goals fact should also be always-injected (profile tier)");
});

await test("createRecallHook always-injects all profile-tier facts including background ones", async () => {
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [] } as any,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async () => [
        { id: "background", category: "goals", key: "goals.health", value: "用户的健康目标是保持健康体重。", score: 0.2 },
        { id: "answer", category: "identity", key: "identity.fact", value: "用户当前的全职工作是某互联网公司程序员。", score: 0.2 },
      ],
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a" },
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
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10, alwaysInjectTiers: ["profile", "general"], retrievalOnlyTiers: ["technical"], maxAlwaysInjectChars: 600 },
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, maxConversationTurns: 1, dedupeThreshold: 0.8 },
      outbox: { enabled: false, concurrency: 1, batchSize: 1, maxRetries: 1, drainTimeoutMs: 1000, persistPath: "", flushIntervalMs: 1000 },
      sync: { flushToMarkdown: false, flushIntervalSec: 300, memoryFilePath: "MEMORY.md" },
    } as any,
    { info: () => {}, warn: () => {} },
    { recallTotal: 0, recallMisses: 0, recallErrors: 0, recordRecallLatency: () => {}, recordRecallCompare: () => {} } as any,
    { registerAgent: () => {} } as any,
  );
  const out = await hook(
    {
      prompt: "请只用一句中文回答：用户当前的全职工作是什么？",
      messages: [{ role: "user", content: "用户当前的全职工作是什么？" }],
    },
    { agentId: "a", workspaceDir: "/tmp", sessionId: "s-job" } as any,
  );
  const prepend = String((out as any)?.prependContext ?? "");
  if (!prepend.includes("用户当前的全职工作是某互联网公司程序员")) throw new Error("exact answer phrase should be selected");
  // Both facts are profile-tier, so both should be always-injected regardless of query relevance
  if (!prepend.includes("用户的健康目标是保持健康体重")) throw new Error("background fact should also be injected (profile tier)");
});

await test("createRecallHook caches core memory per session and reranks locally", async () => {
  let listCalls = 0;
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [] } as any,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async () => {
        listCalls += 1;
        return [
          { id: "core-name", category: "identity", key: "identity.name", value: "用户叫小明。", score: 0.2 },
          { id: "core-embed", category: "tooling", key: "general.embedding", value: "memU embedding 现在用 nomic-embed-text。", score: 0.2 },
          { id: "core-arch", category: "general", key: "general.layers", value: "记忆系统一共有三层。", score: 0.2 },
        ];
      },
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a" },
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
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10, alwaysInjectTiers: ["profile", "general"], retrievalOnlyTiers: ["technical"], maxAlwaysInjectChars: 600 },
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, maxConversationTurns: 1, dedupeThreshold: 0.8 },
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
    { agentId: "a", workspaceDir: "/tmp", sessionId: "s-core-cache" } as any,
  );

  await hook(
    {
      prompt: "请只用一句中文回答：用户叫什么名字？",
      messages: [{ role: "user", content: "用户叫什么名字？" }],
    },
    { agentId: "a", workspaceDir: "/tmp", sessionId: "s-core-cache" } as any,
  );

  assertEqual(listCalls, 1, "core list should be fetched once per session cache window");
});

await test("createRecallHook includes both core and relevant memories when core strongly covers a single-fact query", async () => {
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [{ id: "m1", text: "用户的人格类型是 INTJ", category: "mem0", score: 0.9, source: "memu_item", scope: { userId: "u", agentId: "a", sessionKey: "s" } }] } as any,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async () => [
        { id: "1", category: "identity", key: "identity.timezone", value: "用户的时区是 UTC+8。", score: 0.8 },
      ],
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a" },
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
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10, alwaysInjectTiers: ["profile", "general"], retrievalOnlyTiers: ["technical"], maxAlwaysInjectChars: 600 },
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, maxConversationTurns: 1, dedupeThreshold: 0.8 },
      outbox: { enabled: false, concurrency: 1, batchSize: 1, maxRetries: 1, drainTimeoutMs: 1000, persistPath: "", flushIntervalMs: 1000 },
      sync: { flushToMarkdown: false, flushIntervalSec: 300, memoryFilePath: "MEMORY.md" },
    } as any,
    { info: () => {}, warn: () => {} },
    { recallTotal: 0, recallHits: 0, recallMisses: 0, recallErrors: 0, recordRecallLatency: () => {}, recordRecallCompare: () => {}, recordRecallFallback: () => {} } as any,
    { registerAgent: () => {} } as any,
  );

  const out = await hook(
    {
      prompt: "请只用一句中文回答：用户的时区是什么？",
      messages: [{ role: "user", content: "用户的时区是什么？" }],
    },
    { agentId: "a", workspaceDir: "/tmp", sessionId: "s-relevant-suppress" } as any,
  );

  const prepend = String((out as any)?.prependContext ?? "");
  if (!prepend.includes("<core-memory>")) throw new Error("core memory should remain");
  // Both memory layers now always contribute — relevant memories are no longer suppressed
  if (!prepend.includes("<relevant-memories>")) throw new Error("relevant memories should also be included alongside core");
});

await test("createRecallHook skips duplicate injection inside the same session", async () => {
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [] } as any,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async () => [
        { id: "1", category: "identity", key: "identity.timezone", value: "用户的时区是 UTC+8。", score: 0.8 },
      ],
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a" },
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
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10, alwaysInjectTiers: ["profile", "general"], retrievalOnlyTiers: ["technical"], maxAlwaysInjectChars: 600 },
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, maxConversationTurns: 1, dedupeThreshold: 0.8 },
      outbox: { enabled: false, concurrency: 1, batchSize: 1, maxRetries: 1, drainTimeoutMs: 1000, persistPath: "", flushIntervalMs: 1000 },
      sync: { flushToMarkdown: false, flushIntervalSec: 300, memoryFilePath: "MEMORY.md" },
    } as any,
    { info: () => {}, warn: () => {} },
    { recallTotal: 0, recallHits: 0, recallMisses: 0, recallErrors: 0, recordRecallLatency: () => {}, recordRecallCompare: () => {}, recordRecallFallback: () => {} } as any,
    { registerAgent: () => {} } as any,
  );

  const ctx = { agentId: "a", workspaceDir: "/tmp", sessionId: "s1" } as any;
  const first = await hook(
    {
      prompt: "请只用一句中文回答：用户的时区是什么？",
      messages: [{ role: "user", content: "用户的时区是什么？" }],
    },
    ctx,
  );
  const second = await hook(
    {
      prompt: "请只用一句中文回答：用户的时区是什么？",
      messages: [{ role: "user", content: "用户的时区是什么？" }],
    },
    ctx,
  );

  if (!String((first as any)?.prependContext ?? "").includes("UTC+8")) {
    throw new Error("first call should inject core memory");
  }
  if (second !== undefined) {
    throw new Error("second call in same session should skip duplicate injection");
  }
});

await test("createRecallHook avoids re-injecting the same stable core facts across turns in one session", async () => {
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [] } as any,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async () => {
        return [
          { id: "core-timezone", category: "identity", key: "identity.timezone", value: "用户的时区是 UTC+8。", score: 0.8 },
          { id: "core-role", category: "relationships", key: "relationships.primary", value: "用户最重要的关系对象是伴侣。", score: 0.7 },
        ];
      },
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a" },
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
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10, alwaysInjectTiers: ["profile", "general"], retrievalOnlyTiers: ["technical"], maxAlwaysInjectChars: 600 },
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, maxConversationTurns: 1, dedupeThreshold: 0.8 },
      outbox: { enabled: false, concurrency: 1, batchSize: 1, maxRetries: 1, drainTimeoutMs: 1000, persistPath: "", flushIntervalMs: 1000 },
      sync: { flushToMarkdown: false, flushIntervalSec: 300, memoryFilePath: "MEMORY.md" },
    } as any,
    { info: () => {}, warn: () => {} },
    { recallTotal: 0, recallHits: 0, recallMisses: 0, recallErrors: 0, recordRecallLatency: () => {}, recordRecallCompare: () => {}, recordRecallFallback: () => {} } as any,
    { registerAgent: () => {} } as any,
  );

  const ctx = { agentId: "a", workspaceDir: "/tmp", sessionId: "s2" } as any;
  const first = await hook(
    {
      prompt: "请只用一句中文回答：用户的时区是什么？",
      messages: [{ role: "user", content: "用户的时区是什么？" }],
    },
    ctx,
  );
  const second = await hook(
    {
      prompt: "请只用一句中文回答：用户的爱人是谁？",
      messages: [{ role: "user", content: "用户的爱人是谁？" }],
    },
    ctx,
  );

  const firstText = String((first as any)?.prependContext ?? "");
  const secondText = String((second as any)?.prependContext ?? "");
  if (!firstText.includes("identity/timezone")) {
    throw new Error("first turn should inject the timezone core fact");
  }
  if (!secondText.includes("relationships/primary")) {
    throw new Error("second turn should still inject a new unrepeated core fact");
  }
});

await test("createRecallHook reuses relevant selections for similar session queries", async () => {
  let searchCalls = 0;
  const hook = createRecallHook(
    {
      provider: "mem0",
      search: async () => {
        searchCalls += 1;
        return [
          { id: "m1", text: "用户喜欢茉莉花茶胜过咖啡。", category: "mem0", score: 0.9, source: "memu_item", scope: { userId: "u", agentId: "a", sessionKey: "s" } },
        ];
      },
    } as any,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    { list: async () => [] } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a" },
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
      core: { enabled: false, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10, alwaysInjectTiers: ["profile", "general"], retrievalOnlyTiers: ["technical"], maxAlwaysInjectChars: 600 },
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, maxConversationTurns: 1, dedupeThreshold: 0.8 },
      outbox: { enabled: false, concurrency: 1, batchSize: 1, maxRetries: 1, drainTimeoutMs: 1000, persistPath: "", flushIntervalMs: 1000 },
      sync: { flushToMarkdown: false, flushIntervalSec: 300, memoryFilePath: "MEMORY.md" },
    } as any,
    { info: () => {}, warn: () => {} },
    { recallTotal: 0, recallHits: 0, recallMisses: 0, recallErrors: 0, recordRecallLatency: () => {}, recordRecallCompare: () => {}, recordRecallFallback: () => {} } as any,
    { registerAgent: () => {} } as any,
  );

  await hook(
    {
      prompt: "用户喜欢喝什么饮料？",
      messages: [{ role: "user", content: "用户喜欢喝什么饮料？" }],
    },
    { agentId: "a", workspaceDir: "/tmp", sessionId: "s-relevant-cache" } as any,
  );
  await hook(
    {
      prompt: "用户偏好喝什么饮料？",
      messages: [{ role: "user", content: "用户偏好喝什么饮料？" }],
    },
    { agentId: "a", workspaceDir: "/tmp", sessionId: "s-relevant-cache" } as any,
  );

  assertEqual(searchCalls, 1, "similar session queries should reuse relevant recall selection");
});

await test("createRecallHook returns early for startup prompt (no injection)", async () => {
  let searchCalled = false;
  const hook = createRecallHook(
    { provider: "mem0", search: async () => { searchCalled = true; return []; } } as any,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async () => [
        { id: "1", category: "identity", key: "identity.timezone", value: "用户的时区是 UTC+8。", score: 0.8 },
      ],
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a" },
      recall: {
        enabled: true, method: "rag", hybrid: { enabled: false, alpha: 0.5, fallbackToRag: false },
        topK: 2, scoreThreshold: 0.3, maxContextChars: 1200, injectionBudgetChars: 1200,
        cacheTtlMs: 1000, cacheMaxSize: 10, workspaceFallback: false, workspaceFallbackMaxItems: 0, workspaceFallbackMaxFiles: 0,
      },
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10, alwaysInjectTiers: ["profile", "general"], retrievalOnlyTiers: ["technical"], maxAlwaysInjectChars: 600 },
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, maxConversationTurns: 1, dedupeThreshold: 0.8 },
      outbox: { enabled: false, concurrency: 1, batchSize: 1, maxRetries: 1, drainTimeoutMs: 1000, persistPath: "", flushIntervalMs: 1000 },
      sync: { flushToMarkdown: false, flushIntervalSec: 300, memoryFilePath: "MEMORY.md" },
    } as any,
    { info: () => {}, warn: () => {} },
    { recallTotal: 0, recallHits: 0, recallMisses: 0, recallErrors: 0, recordRecallLatency: () => {}, recordRecallCompare: () => {}, recordRecallFallback: () => {} } as any,
    { registerAgent: () => {} } as any,
  );

  const result = await hook(
    {
      prompt: "A new session was started via /new or /reset. Execute your Session Startup Sequence now...",
      messages: [{ role: "user", content: "A new session was started via /new or /reset. Execute your Session Startup Sequence now..." }],
    },
    { agentId: "a", workspaceDir: "/tmp", sessionId: "s-startup" } as any,
  );
  if (result !== undefined) throw new Error("startup prompt should return early with no injection");
  if (searchCalled) throw new Error("startup prompt should not trigger a backend search");
});

await test("createRecallHook prefers event.prompt when messages contain startup prompt", async () => {
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [] } as any,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async () => [
        { id: "core-tz", category: "identity", key: "identity.timezone", value: "用户的时区是 UTC+8。", score: 0.2 },
      ],
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a" },
      recall: {
        enabled: true, method: "rag", hybrid: { enabled: false, alpha: 0.5, fallbackToRag: false },
        topK: 2, scoreThreshold: 0.3, maxContextChars: 1200, injectionBudgetChars: 1200,
        cacheTtlMs: 1000, cacheMaxSize: 10, workspaceFallback: false, workspaceFallbackMaxItems: 0, workspaceFallbackMaxFiles: 0,
      },
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10, alwaysInjectTiers: ["profile", "general"], retrievalOnlyTiers: ["technical"], maxAlwaysInjectChars: 600 },
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, maxConversationTurns: 1, dedupeThreshold: 0.8 },
      outbox: { enabled: false, concurrency: 1, batchSize: 1, maxRetries: 1, drainTimeoutMs: 1000, persistPath: "", flushIntervalMs: 1000 },
      sync: { flushToMarkdown: false, flushIntervalSec: 300, memoryFilePath: "MEMORY.md" },
    } as any,
    { info: () => {}, warn: () => {} },
    { recallTotal: 0, recallHits: 0, recallMisses: 0, recallErrors: 0, recordRecallLatency: () => {}, recordRecallCompare: () => {}, recordRecallFallback: () => {} } as any,
    { registerAgent: () => {} } as any,
  );

  const result = await hook(
    {
      prompt: "请只用一句中文回答：用户的时区是什么？",
      messages: [{ role: "user", content: "A new session was started via /new or /reset. Execute your Session Startup Sequence now..." }],
    },
    { agentId: "a", workspaceDir: "/tmp", sessionId: "s-prefer-prompt" } as any,
  );
  const prepend = String((result as any)?.prependContext ?? "");
  if (!prepend.includes("UTC+8")) throw new Error("should use event.prompt query and inject timezone");
});

await test("createRecallHook session dedup does not block different queries in same session", async () => {
  const hook = createRecallHook(
    { provider: "mem0", search: async () => [] } as any,
    { resolveRuntimeScope: () => ({ userId: "u", agentId: "a", sessionKey: "agent:a:main" }) } as any,
    {
      list: async () => [
        { id: "core-tz", category: "identity", key: "identity.timezone", value: "用户的时区是 UTC+8。", score: 0.2 },
        { id: "core-job", category: "identity", key: "identity.job", value: "用户当前的全职工作是字节跳动程序员。", score: 0.2 },
      ],
    } as any,
    { get: () => null, set: () => {} } as any,
    { getBySender: async () => "" } as any,
    {
      scope: { userId: "u", agentId: "a" },
      recall: {
        enabled: true, method: "rag", hybrid: { enabled: false, alpha: 0.5, fallbackToRag: false },
        topK: 2, scoreThreshold: 0.3, maxContextChars: 1200, injectionBudgetChars: 1200,
        cacheTtlMs: 1000, cacheMaxSize: 10, workspaceFallback: false, workspaceFallbackMaxItems: 0, workspaceFallbackMaxFiles: 0,
      },
      core: { enabled: true, topK: 5, maxItemChars: 240, autoExtractProposals: false, humanReviewRequired: false, touchOnRecall: false, proposalQueueMax: 10, alwaysInjectTiers: ["profile", "general"], retrievalOnlyTiers: ["technical"], maxAlwaysInjectChars: 600 },
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source", enableGraph: false, searchThreshold: 0.3, topK: 5 },
      capture: { enabled: false, maxItemsPerRun: 0, minChars: 0, maxChars: 0, maxConversationTurns: 1, dedupeThreshold: 0.8 },
      outbox: { enabled: false, concurrency: 1, batchSize: 1, maxRetries: 1, drainTimeoutMs: 1000, persistPath: "", flushIntervalMs: 1000 },
      sync: { flushToMarkdown: false, flushIntervalSec: 300, memoryFilePath: "MEMORY.md" },
    } as any,
    { info: () => {}, warn: () => {} },
    { recallTotal: 0, recallHits: 0, recallMisses: 0, recallErrors: 0, recordRecallLatency: () => {}, recordRecallCompare: () => {}, recordRecallFallback: () => {} } as any,
    { registerAgent: () => {} } as any,
  );

  const ctx = { agentId: "a", workspaceDir: "/tmp", sessionId: "s-dedup-query-aware" } as any;
  const first = await hook(
    {
      prompt: "请只用一句中文回答：用户的时区是什么？",
      messages: [{ role: "user", content: "用户的时区是什么？" }],
    },
    ctx,
  );
  const second = await hook(
    {
      prompt: "请只用一句中文回答：用户当前的全职工作是什么？",
      messages: [{ role: "user", content: "用户当前的全职工作是什么？" }],
    },
    ctx,
  );

  if (!String((first as any)?.prependContext ?? "").includes("UTC+8")) {
    throw new Error("first query should inject timezone");
  }
  if (second === undefined) {
    throw new Error("second different query in same session should NOT be deduped");
  }
  if (!String((second as any)?.prependContext ?? "").includes("字节跳动程序员")) {
    throw new Error("second query should inject job fact");
  }
});

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
