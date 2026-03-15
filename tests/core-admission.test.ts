// ============================================================================
// Unit Tests for Core Admission Gate (LLM-based candidate judgment)
// Run with: npx tsx tests/core-admission.test.ts
// ============================================================================

import { buildUserPrompt, parseAdmissionResponse, judgeCandidates } from "../core-admission.js";
import type { AdmissionResult } from "../core-admission.js";
import type { LlmGateConfig } from "../types.js";

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

const testLogger = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
};

console.log("\nCore Admission Gate Tests\n");

// ========================================================================
// buildUserPrompt tests
// ========================================================================

await test("buildUserPrompt formats texts as numbered list", () => {
  const result = buildUserPrompt(["我叫小明", "我在字节跳动工作"]);
  assert(result.includes("1. 我叫小明"), "should contain numbered item 1");
  assert(result.includes("2. 我在字节跳动工作"), "should contain numbered item 2");
  assert(result.startsWith("消息列表:"), "should start with header");
});

await test("buildUserPrompt handles single text", () => {
  const result = buildUserPrompt(["hello world"]);
  assert(result.includes("1. hello world"), "single item");
  assert(!result.includes("2."), "no second item");
});

// ========================================================================
// parseAdmissionResponse tests
// ========================================================================

await test("parseAdmissionResponse parses valid JSON array", () => {
  const input = JSON.stringify([
    { index: 1, verdict: "core", key: "identity.name", value: "用户叫昊", reason: "身份信息" },
    { index: 2, verdict: "free_text", value: "在做推荐系统优化" },
    { index: 3, verdict: "discard" },
  ]);
  const results = parseAdmissionResponse(input);
  assertEqual(results.length, 3, "should parse 3 results");
  assertEqual(results[0].verdict, "core", "first is core");
  assertEqual(results[0].key, "identity.name", "key preserved");
  assertEqual(results[0].value, "用户叫昊", "value preserved");
  assertEqual(results[1].verdict, "free_text", "second is free_text");
  assertEqual(results[2].verdict, "discard", "third is discard");
});

await test("parseAdmissionResponse handles markdown-wrapped JSON", () => {
  const input = "```json\n[{\"index\": 1, \"verdict\": \"core\", \"key\": \"work.company\", \"value\": \"在字节跳动\"}]\n```";
  const results = parseAdmissionResponse(input);
  assertEqual(results.length, 1, "should extract from markdown");
  assertEqual(results[0].key, "work.company", "key extracted");
});

await test("parseAdmissionResponse handles JSON with surrounding text", () => {
  const input = "根据分析结果：\n[{\"index\": 1, \"verdict\": \"core\", \"key\": \"identity.role\", \"value\": \"前端工程师\"}]\n以上是判断结果。";
  const results = parseAdmissionResponse(input);
  assertEqual(results.length, 1, "should extract embedded JSON");
  assertEqual(results[0].value, "前端工程师", "value extracted");
});

await test("parseAdmissionResponse returns empty for invalid JSON", () => {
  assertEqual(parseAdmissionResponse("not json at all").length, 0, "garbage input");
  assertEqual(parseAdmissionResponse("").length, 0, "empty string");
  assertEqual(parseAdmissionResponse(null).length, 0, "null");
  assertEqual(parseAdmissionResponse(undefined).length, 0, "undefined");
});

await test("parseAdmissionResponse skips items with invalid index", () => {
  const input = JSON.stringify([
    { index: 0, verdict: "core", key: "x", value: "y" },    // index 0 invalid (< 1)
    { index: -1, verdict: "core", key: "x", value: "y" },   // negative
    { verdict: "core", key: "x", value: "y" },               // missing index
    { index: 1, verdict: "core", key: "a", value: "b" },     // valid
  ]);
  const results = parseAdmissionResponse(input);
  assertEqual(results.length, 1, "only valid item");
  assertEqual(results[0].index, 1, "correct index");
});

await test("parseAdmissionResponse skips items with invalid verdict", () => {
  const input = JSON.stringify([
    { index: 1, verdict: "unknown" },
    { index: 2, verdict: "core", key: "x", value: "y" },
  ]);
  const results = parseAdmissionResponse(input);
  assertEqual(results.length, 1, "skip invalid verdict");
  assertEqual(results[0].index, 2, "correct item");
});

await test("parseAdmissionResponse handles missing optional fields", () => {
  const input = JSON.stringify([
    { index: 1, verdict: "free_text" },
  ]);
  const results = parseAdmissionResponse(input);
  assertEqual(results.length, 1, "parsed");
  assertEqual(results[0].key, undefined, "key undefined");
  assertEqual(results[0].value, undefined, "value undefined");
  assertEqual(results[0].reason, undefined, "reason undefined");
});

// ========================================================================
// judgeCandidates tests (mocked HTTP)
// ========================================================================

await test("judgeCandidates returns empty when no API key", async () => {
  const config: LlmGateConfig = {
    enabled: true,
    apiBase: "https://api.openai.com/v1",
    apiKey: undefined,
    model: "gpt-4o-mini",
    maxTokensPerBatch: 2000,
    timeoutMs: 30_000,
  };
  const results = await judgeCandidates(["test text"], config, testLogger);
  assertEqual(results.length, 0, "no results without API key");
});

await test("judgeCandidates returns empty for empty input", async () => {
  const config: LlmGateConfig = {
    enabled: true,
    apiBase: "https://api.openai.com/v1",
    apiKey: "sk-test",
    model: "gpt-4o-mini",
    maxTokensPerBatch: 2000,
    timeoutMs: 30_000,
  };
  const results = await judgeCandidates([], config, testLogger);
  assertEqual(results.length, 0, "no results for empty input");
});

await test("judgeCandidates handles HTTP error gracefully", async () => {
  // Mock fetch to return error
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Internal Server Error", { status: 500 });

  try {
    const config: LlmGateConfig = {
      enabled: true,
      apiBase: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      maxTokensPerBatch: 2000,
      timeoutMs: 30_000,
    };
    const results = await judgeCandidates(["test"], config, testLogger);
    assertEqual(results.length, 0, "graceful fallback on HTTP error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("judgeCandidates handles network error gracefully", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network unreachable"); };

  try {
    const config: LlmGateConfig = {
      enabled: true,
      apiBase: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      maxTokensPerBatch: 2000,
      timeoutMs: 30_000,
    };
    const results = await judgeCandidates(["test"], config, testLogger);
    assertEqual(results.length, 0, "graceful fallback on network error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("judgeCandidates parses successful LLM response", async () => {
  const originalFetch = globalThis.fetch;
  const mockResponse = {
    choices: [{
      message: {
        content: JSON.stringify([
          { index: 1, verdict: "core", key: "work.company", value: "在字节跳动工作", reason: "工作信息" },
          { index: 2, verdict: "discard" },
        ]),
      },
    }],
  };
  globalThis.fetch = async () => new Response(JSON.stringify(mockResponse), { status: 200 });

  try {
    const config: LlmGateConfig = {
      enabled: true,
      apiBase: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      maxTokensPerBatch: 2000,
      timeoutMs: 30_000,
    };
    const results = await judgeCandidates(["我在字节跳动工作", "ok"], config, testLogger);
    assertEqual(results.length, 2, "2 results from LLM");
    assertEqual(results[0].verdict, "core", "first is core");
    assertEqual(results[0].key, "work.company", "key correct");
    assertEqual(results[1].verdict, "discard", "second is discard");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("judgeCandidates handles empty content in response", async () => {
  const originalFetch = globalThis.fetch;
  const mockResponse = { choices: [{ message: { content: "" } }] };
  globalThis.fetch = async () => new Response(JSON.stringify(mockResponse), { status: 200 });

  try {
    const config: LlmGateConfig = {
      enabled: true,
      apiBase: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      maxTokensPerBatch: 2000,
      timeoutMs: 30_000,
    };
    const results = await judgeCandidates(["test"], config, testLogger);
    assertEqual(results.length, 0, "empty content returns no results");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("judgeCandidates sends correct request format", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  let capturedHeaders: Record<string, string> = {};

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = typeof input === "string" ? input : input.toString();
    capturedBody = JSON.parse(init?.body as string);
    const headers = init?.headers as Record<string, string>;
    capturedHeaders = headers;
    return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200 });
  };

  try {
    const config: LlmGateConfig = {
      enabled: true,
      apiBase: "https://custom.api.com/v1/",
      apiKey: "sk-custom-key",
      model: "deepseek-chat",
      maxTokensPerBatch: 1500,
      timeoutMs: 10_000,
    };
    await judgeCandidates(["test message"], config, testLogger);

    assertEqual(capturedUrl, "https://custom.api.com/v1/chat/completions", "correct URL (trailing slash stripped)");
    assertEqual(capturedBody.model, "deepseek-chat", "correct model");
    assertEqual(capturedBody.max_tokens, 1500, "correct max_tokens");
    assertEqual(capturedHeaders.Authorization, "Bearer sk-custom-key", "correct auth header");
    assert(Array.isArray(capturedBody.messages), "messages is array");
    assertEqual((capturedBody.messages as Array<{role: string}>).length, 2, "system + user messages");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// Summary
// ============================================================================

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;

console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);

if (failed > 0) {
  console.log("\nFailed tests:");
  for (const r of results.filter((r) => !r.passed)) {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  }
  process.exit(1);
}
