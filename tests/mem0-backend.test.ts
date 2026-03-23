import { Mem0FreeTextBackend, effectiveUserId, resolveOssLlmConfigForTests, sanitizeJsonLikeResponse } from "../backends/free-text/mem0.js";
import { loadConfig } from "../types.js";

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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const logger = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
};

console.log("\nMem0 Backend Tests\n");

await test("effectiveUserId keeps base user for main agent", () => {
  assertEqual(
    effectiveUserId({ userId: "alice", agentId: "main", sessionKey: "agent:main:main" }),
    "alice",
    "main agent namespace",
  );
});

await test("effectiveUserId namespaces non-main agents", () => {
  assertEqual(
    effectiveUserId({ userId: "alice", agentId: "researcher", sessionKey: "agent:researcher:1" }),
    "alice:agent:researcher",
    "researcher namespace",
  );
});

await test("loadConfig parses mem0 backend options", () => {
  const cfg = loadConfig({
    backend: { freeText: { provider: "mem0" } },
    mem0: { mode: "open-source", topK: 7, searchThreshold: 0.42, customPrompt: "extract facts" },
  });
  assertEqual(cfg.backend.freeText.provider, "mem0", "provider");
  assertEqual(cfg.mem0.mode, "open-source", "mode");
  assertEqual(cfg.mem0.topK, 7, "topK");
  assertEqual(cfg.mem0.searchThreshold, 0.42, "searchThreshold");
  assertEqual(cfg.mem0.customPrompt, "extract facts", "customPrompt");
});

await test("graph config rewrites google llm to OpenAI-compatible config", () => {
  const cfg = loadConfig({
    geminiApiKey: "gemini-key",
    mem0: {
      mode: "open-source",
      enableGraph: true,
      oss: {
        llm: {
          provider: "google",
          config: { model: "gemini-2.5-flash" },
        },
        graph_store: {
          provider: "neo4j",
          config: { url: "bolt://localhost:7687", username: "neo4j", password: "password" },
        },
      },
    },
  });

  const resolved = resolveOssLlmConfigForTests(cfg.mem0, cfg.kimiApiKey ?? cfg.geminiApiKey);
  assertEqual(resolved.topLevelLlm?.provider, "openai", "top-level provider should be rewritten");
  assertEqual(resolved.graphStoreLlm?.provider, "openai", "graph provider should be rewritten");
  assertEqual(resolved.topLevelLlm?.config.baseURL, "https://generativelanguage.googleapis.com/v1beta/openai", "should inject Google OpenAI-compatible baseURL");
  assertEqual(resolved.graphStoreLlm?.config.apiKey, "gemini-key", "should inherit gemini api key");
  assertEqual(resolved.graphStoreLlm?.config.model, "gemini-2.5-flash", "should preserve model");
});

await test("loadConfig normalizes kimi-coding llm provider for mem0 oss", () => {
  const cfg = loadConfig({
    kimiApiKey: "kimi-key",
    mem0: {
      mode: "open-source",
      oss: {
        llm: {
          provider: "kimi-coding",
          config: { model: "kimi-coding/k2p5" },
        },
      },
    },
  });

  assertEqual(cfg.mem0.oss?.llm?.provider, "kimi_coding", "kimi provider should be rewritten for mem0");
  assertEqual(cfg.mem0.oss?.llm?.config.kimi_coding_base_url, "https://api.kimi.com/coding/", "should inject Kimi coding baseURL");
  assertEqual(cfg.mem0.oss?.llm?.config.model, "k2p5", "should strip provider prefix");
  assertEqual(cfg.mem0.oss?.llm?.config.apiKey, "kimi-key", "should inherit kimi api key");
});

await test("loadConfig normalizes classifier and llmGate kimi-style model ids", () => {
  const cfg = loadConfig({
    kimiApiKey: "kimi-key",
    classifier: {
      model: "kimi-coding/k2p5",
    },
    core: {
      llmGate: {
        enabled: true,
        model: "kimi-coding/k2p5-thinking",
      },
    },
  });

  assertEqual(cfg.classifier.apiBase, "https://api.kimi.com/coding/", "classifier should use Kimi baseURL");
  assertEqual(cfg.classifier.model, "k2p5", "classifier should strip provider prefix");
  assertEqual(cfg.classifier.apiKey, "kimi-key", "classifier should inherit kimi api key");
  assertEqual(cfg.core.llmGate.apiBase, "https://api.kimi.com/coding/", "llmGate should use Kimi baseURL");
  assertEqual(cfg.core.llmGate.model, "k2p5-thinking", "llmGate should strip provider prefix");
  assertEqual(cfg.core.llmGate.apiKey, "kimi-key", "llmGate should inherit kimi api key");
});

await test("loadConfig inherits gemini api key for graph_store llm", () => {
  const cfg = loadConfig({
    geminiApiKey: "gemini-key",
    mem0: {
      mode: "open-source",
      enableGraph: true,
      oss: {
        llm: {
          provider: "google",
          config: { model: "gemini-2.5-flash" },
        },
        graph_store: {
          provider: "neo4j",
          config: { url: "bolt://localhost:7687", username: "neo4j", password: "password" },
          llm: {
            provider: "google",
            config: { model: "gemini-2.5-pro" },
          },
        },
      },
    },
  });

  assertEqual(cfg.mem0.oss?.graph_store?.llm?.config.apiKey, "gemini-key", "graph_store llm should inherit gemini api key");
});

await test("graph config preserves explicit OpenAI-compatible baseURL", () => {
  const cfg = loadConfig({
    mem0: {
      mode: "open-source",
      enableGraph: true,
      oss: {
        llm: {
          provider: "google",
          config: {
            model: "gemini-2.5-flash",
            apiKey: "explicit-key",
            baseURL: "https://example.test/openai",
          },
        },
        graph_store: {
          provider: "neo4j",
          config: { url: "bolt://localhost:7687", username: "neo4j", password: "password" },
        },
      },
    },
  });

  const resolved = resolveOssLlmConfigForTests(cfg.mem0, cfg.kimiApiKey ?? cfg.geminiApiKey);
  assertEqual(resolved.topLevelLlm?.config.baseURL, "https://example.test/openai", "should preserve explicit baseURL");
  assertEqual(resolved.topLevelLlm?.config.apiKey, "explicit-key", "should preserve explicit apiKey");
});

await test("graph config keeps non-google provider unchanged", () => {
  const cfg = loadConfig({
    mem0: {
      mode: "open-source",
      enableGraph: true,
      oss: {
        llm: {
          provider: "openai",
          config: { model: "gpt-4.1-mini", apiKey: "sk-test", baseURL: "https://api.openai.com/v1" },
        },
        graph_store: {
          provider: "neo4j",
          config: { url: "bolt://localhost:7687", username: "neo4j", password: "password" },
        },
      },
    },
  });

  const resolved = resolveOssLlmConfigForTests(cfg.mem0, cfg.kimiApiKey ?? cfg.geminiApiKey);
  assertEqual(resolved.topLevelLlm?.provider, "openai", "provider should remain openai");
  assertEqual(resolved.topLevelLlm?.config.baseURL, "https://api.openai.com/v1", "baseURL should remain unchanged");
});

await test("loadConfig does not inherit gemini api key for ollama llm", () => {
  const cfg = loadConfig({
    geminiApiKey: "gemini-key",
    mem0: {
      mode: "open-source",
      oss: {
        llm: {
          provider: "ollama",
          config: { model: "qwen2:7b", url: "http://127.0.0.1:11434" },
        },
      },
    },
  });

  assertEqual(cfg.mem0.oss?.llm?.provider, "ollama", "provider should remain ollama");
  assertEqual((cfg.mem0.oss?.llm?.config as Record<string, unknown>).apiKey, undefined, "ollama should not inherit apiKey");
});

await test("store maps non-main agents to namespaced user and preserves session scope", async () => {
  let capturedMessages: Array<{ role: string; content: string }> | null = null;
  let capturedOptions: Record<string, unknown> | null = null;
  const backend = new Mem0FreeTextBackend(
    loadConfig({
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "open-source" },
    }),
    logger,
    async () => ({
      add: async (messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) => {
        capturedMessages = messages;
        capturedOptions = options;
        return { results: [{ id: "m1", event: "ADD" }] };
      },
      search: async () => [],
      getAll: async () => [],
      delete: async () => {},
    }),
  );

  const ok = await backend.store(
    [{ role: "user", content: "remember this preference" }],
    { userId: "alice", agentId: "researcher", sessionKey: "agent:researcher:main" },
    { sessionScoped: true, metadata: { capture_kind: "explicit", tag: "demo" } },
  );

  assertEqual(ok, true, "store ok");
  assertEqual((capturedMessages as Array<{ content: string }> | null)?.[0]?.content, "remember this preference", "stored text");
  assertEqual((capturedOptions as Record<string, unknown> | null)?.userId, "alice:agent:researcher", "namespaced user");
  assertEqual((capturedOptions as Record<string, unknown> | null)?.runId, "agent:researcher:main", "run id");
  const metadata = (capturedOptions as Record<string, unknown> | null)?.metadata as Record<string, unknown>;
  assertEqual(metadata.scope_user_id, "alice", "base user metadata");
  assertEqual(metadata.scope_agent_id, "researcher", "agent metadata");
  assertEqual(metadata.capture_kind, "explicit", "capture kind");
  assertEqual(metadata.tag, "demo", "custom metadata");
});

await test("store injects default long-term instructions for platform mode", async () => {
  let capturedOptions: Record<string, unknown> | null = null;
  const backend = new Mem0FreeTextBackend(
    loadConfig({
      backend: { freeText: { provider: "mem0" } },
      mem0: { mode: "platform", apiKey: "test-key" },
    }),
    logger,
    async () => ({
      add: async (_messages: unknown, options: Record<string, unknown>) => {
        capturedOptions = options;
        return { results: [{ id: "m1", event: "ADD" }] };
      },
      search: async () => [],
      getAll: async () => [],
      delete: async () => {},
    }),
  );

  await backend.store(
    [{ role: "user", content: "记住这个长期结论" }],
    { userId: "alice", agentId: "main", sessionKey: "agent:main:main" },
    { metadata: { capture_kind: "explicit" } },
  );

  assert(typeof (capturedOptions as Record<string, unknown> | null)?.custom_instructions === "string", "default instructions should be included");
});

await test("store forces infer=false for kimi_coding oss mode", async () => {
  let capturedOptions: Record<string, unknown> | null = null;
  const backend = new Mem0FreeTextBackend(
    loadConfig({
      backend: { freeText: { provider: "mem0" } },
      kimiApiKey: "kimi-key",
      mem0: {
        mode: "open-source",
        oss: {
          llm: {
            provider: "kimi_coding",
            config: { model: "k2p5" },
          },
        },
      },
    }),
    logger,
    async () => ({
      add: async (_messages: unknown, options: Record<string, unknown>) => {
        capturedOptions = options;
        return { results: [{ id: "m1", event: "ADD" }] };
      },
      search: async () => [],
      getAll: async () => [],
      delete: async () => {},
    }),
  );

  await backend.store(
    [{ role: "user", content: "remember this exact durable fact" }],
    { userId: "alice", agentId: "main", sessionKey: "agent:main:main" },
  );

  assertEqual((capturedOptions as Record<string, unknown> | null)?.infer, false, "kimi oss store should disable mem0 inference");
});

await test("search combines long-term and session memories without duplicates", async () => {
  const searchCalls: Array<Record<string, unknown>> = [];
  const backend = new Mem0FreeTextBackend(
    loadConfig({
      backend: { freeText: { provider: "mem0" } },
      mem0: {
        mode: "open-source",
        topK: 5,
        searchThreshold: 0.25,
      },
    }),
    logger,
    async () => ({
      add: async () => ({ results: [] }),
      search: async (_query, options) => {
        searchCalls.push(options);
        if ((options as Record<string, unknown>).runId) {
          return [
            { id: "s1", memory: "session fact", score: 0.92, categories: ["session"] },
            { id: "dup", memory: "shared fact", score: 0.88, categories: ["session"] },
          ];
        }
        return [
          { id: "dup", memory: "shared fact", score: 0.9, categories: ["general"] },
          { id: "l1", memory: "long fact", score: 0.85, categories: ["general"] },
        ];
      },
      getAll: async () => [],
      delete: async () => {},
    }),
  );

  const results = await backend.search("what do we know", { userId: "alice", agentId: "researcher", sessionKey: "agent:researcher:main" }, {
    maxItems: 5,
    includeSessionScope: true,
  });

  assertEqual(searchCalls.length, 2, "search calls");
  assertEqual(searchCalls[0]?.userId, "alice:agent:researcher", "long-term user");
  assertEqual(searchCalls[1]?.runId, "agent:researcher:main", "session run id");
  assertEqual(results.length, 3, "combined unique results");
  assert(results.some((item) => item.text === "long fact"), "includes long-term fact");
  assert(results.some((item) => item.text === "session fact"), "includes session fact");
  assertEqual(results.filter((item) => item.text === "shared fact").length, 1, "dedup shared fact");
});

await test("search applies metadata filters before returning results", async () => {
  const backend = new Mem0FreeTextBackend(
    loadConfig({
      backend: { freeText: { provider: "mem0" } },
      mem0: {
        mode: "open-source",
        topK: 5,
        searchThreshold: 0.25,
      },
    }),
    logger,
    async () => ({
      add: async () => ({ results: [] }),
      search: async () => [
        {
          id: "p1",
          memory: "The user prefers jasmine tea over coffee.",
          score: 0.91,
          categories: ["mem0"],
          metadata: { quality: "durable", memory_kind: "preference", capture_kind: "explicit" },
        },
        {
          id: "s1",
          memory: "Tomorrow morning standup moved to 9am.",
          score: 0.95,
          categories: ["mem0"],
          metadata: { quality: "transient", memory_kind: "schedule", capture_kind: "auto" },
        },
      ],
      getAll: async () => [],
      delete: async () => {},
    }),
  );

  const results = await backend.search("what should we remember", { userId: "alice", agentId: "researcher", sessionKey: "agent:researcher:main" }, {
    maxItems: 5,
    quality: "durable",
    memoryKinds: ["preference"],
    captureKind: "explicit",
  });

  assertEqual(results.length, 1, "only durable preference should remain");
  assertEqual(results[0]?.text, "The user prefers jasmine tea over coffee.", "expected durable preference");
});

await test("sanitizeJsonLikeResponse trims trailing fence noise after JSON", () => {
  const raw = '{\n  "memory": [{"id":"0","text":"fact","event":"ADD"}]\n}\n```';
  const cleaned = sanitizeJsonLikeResponse(raw);
  assertEqual(cleaned, '{\n  "memory": [{"id":"0","text":"fact","event":"ADD"}]\n}', "cleaned response");
});

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
