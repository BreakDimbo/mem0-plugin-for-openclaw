// ============================================================================
// Tests: llm-config.ts — API config normalization utilities
// Run with: npx tsx tests/llm-config.test.ts
// ============================================================================

import {
  getKimiCodingBaseUrl,
  getKimiCodingDefaultModel,
  getKimiCodingDefaultReasoningModel,
  normalizeProviderName,
  isGoogleProvider,
  isKimiCodingProvider,
  isKimiCodingBaseUrl,
  isLocalOllamaBaseUrl,
  buildKimiMessagesUrl,
  stripProviderPrefix,
  normalizeChatApiConfig,
  normalizeMem0LlmConfig,
} from "../llm-config.js";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
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

console.log("\nLLM Config Tests\n");

// ── Constant getters ──────────────────────────────────────────────────────────

test("getKimiCodingBaseUrl returns correct URL", () => {
  const url = getKimiCodingBaseUrl();
  assert(url.startsWith("https://api.kimi.com"), "starts with kimi domain");
  assert(url.endsWith("/"), "ends with slash");
});

test("getKimiCodingDefaultModel returns k2p5", () => {
  assertEqual(getKimiCodingDefaultModel(), "k2p5", "default model");
});

test("getKimiCodingDefaultReasoningModel returns k2p5-thinking", () => {
  assertEqual(getKimiCodingDefaultReasoningModel(), "k2p5-thinking", "reasoning model");
});

// ── normalizeProviderName ─────────────────────────────────────────────────────

test("normalizeProviderName lowercases and trims", () => {
  assertEqual(normalizeProviderName("  OpenAI  "), "openai", "trimmed and lowercased");
});

test("normalizeProviderName handles undefined", () => {
  assertEqual(normalizeProviderName(undefined), "", "undefined → empty string");
});

// ── isGoogleProvider ──────────────────────────────────────────────────────────

test("isGoogleProvider: 'google' → true", () => {
  assert(isGoogleProvider("google"), "google");
  assert(isGoogleProvider("Google"), "case insensitive");
  assert(isGoogleProvider("gemini"), "gemini");
});

test("isGoogleProvider: other providers → false", () => {
  assert(!isGoogleProvider("openai"), "openai not google");
  assert(!isGoogleProvider(undefined), "undefined not google");
});

// ── isKimiCodingProvider ──────────────────────────────────────────────────────

test("isKimiCodingProvider: 'kimi-coding' and 'kimi_coding' → true", () => {
  assert(isKimiCodingProvider("kimi-coding"), "dash variant");
  assert(isKimiCodingProvider("kimi_coding"), "underscore variant (mem0 format)");
  assert(isKimiCodingProvider("KIMI-CODING"), "case insensitive");
});

test("isKimiCodingProvider: other → false", () => {
  assert(!isKimiCodingProvider("openai"), "openai");
  assert(!isKimiCodingProvider(undefined), "undefined");
});

// ── isKimiCodingBaseUrl ───────────────────────────────────────────────────────

test("isKimiCodingBaseUrl: exact kimi URL → true", () => {
  assert(isKimiCodingBaseUrl("https://api.kimi.com/coding/"), "with trailing slash");
  assert(isKimiCodingBaseUrl("https://api.kimi.com/coding"), "without trailing slash");
});

test("isKimiCodingBaseUrl: other URLs → false", () => {
  assert(!isKimiCodingBaseUrl("https://api.openai.com/v1"), "openai");
  assert(!isKimiCodingBaseUrl(undefined), "undefined");
  assert(!isKimiCodingBaseUrl(""), "empty string");
});

// ── isLocalOllamaBaseUrl ──────────────────────────────────────────────────────

test("isLocalOllamaBaseUrl: localhost:11434 → true", () => {
  assert(isLocalOllamaBaseUrl("http://localhost:11434/v1"), "localhost with path");
  assert(isLocalOllamaBaseUrl("http://127.0.0.1:11434/v1"), "127.0.0.1");
});

test("isLocalOllamaBaseUrl: wrong port or host → false", () => {
  assert(!isLocalOllamaBaseUrl("http://localhost:8080/v1"), "wrong port");
  assert(!isLocalOllamaBaseUrl("http://192.168.1.1:11434/v1"), "remote host");
  assert(!isLocalOllamaBaseUrl(undefined), "undefined");
  assert(!isLocalOllamaBaseUrl("not-a-url"), "invalid URL");
});

// ── buildKimiMessagesUrl ──────────────────────────────────────────────────────

test("buildKimiMessagesUrl: kimi base → appends /v1/messages", () => {
  const url = buildKimiMessagesUrl("https://api.kimi.com/coding/");
  assert(url.endsWith("/v1/messages"), "ends with /v1/messages");
});

test("buildKimiMessagesUrl: undefined → uses kimi default", () => {
  const url = buildKimiMessagesUrl(undefined);
  assert(url.includes("kimi.com"), "uses kimi default");
});

// ── stripProviderPrefix ───────────────────────────────────────────────────────

test("stripProviderPrefix: 'openai/gpt-4o' → 'gpt-4o'", () => {
  assertEqual(stripProviderPrefix("openai/gpt-4o"), "gpt-4o", "strips openai/ prefix");
});

test("stripProviderPrefix: 'kimi-coding/k2p5' → 'k2p5'", () => {
  assertEqual(stripProviderPrefix("kimi-coding/k2p5"), "k2p5", "strips kimi prefix");
});

test("stripProviderPrefix: model without prefix returned as-is", () => {
  assertEqual(stripProviderPrefix("gpt-4o"), "gpt-4o", "no prefix, unchanged");
});

test("stripProviderPrefix: undefined → undefined", () => {
  assertEqual(stripProviderPrefix(undefined), undefined, "undefined input");
});

test("stripProviderPrefix: empty string → undefined", () => {
  assertEqual(stripProviderPrefix(""), undefined, "empty string");
});

// ── normalizeChatApiConfig ────────────────────────────────────────────────────

test("normalizeChatApiConfig: kimi model prefix triggers kimi base URL", () => {
  const result = normalizeChatApiConfig({ model: "kimi-coding/k2p5" });
  assert(isKimiCodingBaseUrl(result.apiBase), "apiBase set to kimi");
  assertEqual(result.model, "k2p5", "provider prefix stripped from model");
});

test("normalizeChatApiConfig: explicit kimi apiBase preserved", () => {
  const result = normalizeChatApiConfig({
    apiBase: "https://api.kimi.com/coding/",
    model: "k2p5",
  });
  assert(isKimiCodingBaseUrl(result.apiBase), "kimi apiBase kept");
  assertEqual(result.model, "k2p5", "model unchanged");
});

test("normalizeChatApiConfig: non-kimi apiBase preserved", () => {
  const result = normalizeChatApiConfig({
    apiBase: "http://localhost:11434/v1",
    model: "qwen2.5:14b",
  });
  assertEqual(result.apiBase, "http://localhost:11434/v1", "local base preserved");
  assertEqual(result.model, "qwen2.5:14b", "model unchanged");
});

test("normalizeChatApiConfig: empty config falls back to kimi defaults", () => {
  const result = normalizeChatApiConfig({});
  assert(isKimiCodingBaseUrl(result.apiBase), "falls back to kimi base");
  assertEqual(result.model, getKimiCodingDefaultModel(), "falls back to default model");
});

// ── normalizeMem0LlmConfig ────────────────────────────────────────────────────

test("normalizeMem0LlmConfig: undefined input → undefined", () => {
  assertEqual(normalizeMem0LlmConfig(undefined), undefined, "undefined passthrough");
});

test("normalizeMem0LlmConfig: kimi-coding provider normalized to kimi_coding", () => {
  const result = normalizeMem0LlmConfig({ provider: "kimi-coding", config: { apiKey: "key123" } });
  assertEqual(result?.provider, "kimi_coding", "provider normalized to mem0 format");
  assertEqual(result?.config.apiKey, "key123", "apiKey preserved");
});

test("normalizeMem0LlmConfig: fallbackApiKey injected when config has none", () => {
  const result = normalizeMem0LlmConfig(
    { provider: "openai", config: { model: "gpt-4o" } },
    "fallback-key",
  );
  assertEqual(result?.config.apiKey, "fallback-key", "fallback apiKey injected");
});

test("normalizeMem0LlmConfig: ollama provider does NOT inherit fallback apiKey", () => {
  const result = normalizeMem0LlmConfig(
    { provider: "ollama", config: {} },
    "fallback-key",
  );
  assert(!("apiKey" in (result?.config ?? {})), "ollama does not inherit apiKey");
});

test("normalizeMem0LlmConfig: existing apiKey takes precedence over fallback", () => {
  const result = normalizeMem0LlmConfig(
    { provider: "openai", config: { apiKey: "own-key" } },
    "fallback-key",
  );
  assertEqual(result?.config.apiKey, "own-key", "own key not overridden");
});

// Summary
console.log();
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
