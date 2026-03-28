// ============================================================================
// Integration test: batch reranker → real Ollama qwen2.5:7b
// Run with: npx tsx tests/reranker-integration.test.ts
// ============================================================================

import { patchRerankerBatch } from "../backends/free-text/mem0.js";

const OLLAMA_URL = "http://localhost:11434/v1/chat/completions";
const MODEL = "qwen2.5:7b";

const QUERY = "vim editor preferences";
const DOCS: Array<Record<string, unknown>> = [
  { memory: "无紧急事项需要关注" },
  { memory: "4. 模式推广：无需要推广的模式" },
  { memory: "用户偏好 vim 编辑器，使用 tabstop=2，启用语法高亮" },
  { memory: "验证报告指出，确认窗口与 OOS 高度一致，策略无性能退化。" },
  { memory: "The current time is Monday." },
];

// ── Setup ────────────────────────────────────────────────────────────────────

// Check Ollama is reachable before proceeding
try {
  const ping = await fetch("http://localhost:11434/api/tags");
  if (!ping.ok) throw new Error("not ok");
} catch {
  console.error("✗ Ollama not reachable at localhost:11434 — skipping integration test");
  process.exit(0);
}

let llmCallCount = 0;
let lastRawResponse = "";
const realLlm = {
  generateResponse: async (messages: Array<{ role: string; content: string }>) => {
    llmCallCount++;
    const resp = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.0,
        max_tokens: 150,
        stream: false,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const json = await resp.json() as any;
    lastRawResponse = json.choices?.[0]?.message?.content ?? "";
    return lastRawResponse;
  },
};

let serialFallbackCount = 0;
const memory = {
  llm: realLlm,
  reranker: {
    config: { top_k: null },
    llm: realLlm,
    rerank: async (_q: string, docs: Array<Record<string, unknown>>) => {
      serialFallbackCount += docs.length;
      return docs;
    },
  },
};

patchRerankerBatch(memory as unknown as Record<string, unknown>);

// ── Run ───────────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log("Batch Reranker — Real Ollama Integration Test");
console.log(`Model: ${MODEL}  |  Query: "${QUERY}"  |  Expected winner: vim doc`);
console.log(`Docs: ${DOCS.length}  |  Expected LLM calls: 1`);
console.log(`${"═".repeat(60)}\n`);

const start = Date.now();
const result = await (memory as any).reranker.rerank(
  QUERY,
  DOCS,
) as Array<Record<string, unknown>>;
const elapsed = Date.now() - start;

console.log(`LLM calls: ${llmCallCount}  |  Serial fallback calls: ${serialFallbackCount}  |  Time: ${elapsed}ms`);
console.log(`Raw LLM response: ${JSON.stringify(lastRawResponse)}\n`);

console.log("Ranked results:");
for (const doc of result) {
  const score = doc.rerank_score as number;
  const bar = "█".repeat(Math.round(score * 20)).padEnd(20, "░");
  console.log(`  ${score.toFixed(2)} ${bar}  "${doc.memory}"`);
}

// ── Assertions ────────────────────────────────────────────────────────────────

type TestResult = { name: string; passed: boolean };
const results: TestResult[] = [];

function check(name: string, cond: boolean): void {
  results.push({ name, passed: cond });
  console.log(`\n  ${cond ? "✓" : "✗"} ${name}`);
}

console.log(`\n${"─".repeat(60)}`);

check(`1 LLM call for ${DOCS.length} docs (batch, not serial)`, llmCallCount === 1);
check("No serial fallback triggered", serialFallbackCount === 0);
check(`All ${DOCS.length} docs returned`, result.length === DOCS.length);
check("Every result has rerank_score attached", result.every((r) => typeof r.rerank_score === "number"));
check("Results sorted descending by rerank_score", (() => {
  for (let i = 0; i < result.length - 1; i++) {
    if ((result[i].rerank_score as number) < (result[i + 1].rerank_score as number)) return false;
  }
  return true;
})());
check("Original doc fields preserved (memory key intact)", result.every((r) => typeof r.memory === "string"));

const vimDoc = result.find((r) => String(r.memory).includes("vim"));
const noiseItems = result.filter((r) =>
  String(r.memory).includes("无紧急事项") || String(r.memory).includes("无需要") || String(r.memory).includes("current time"),
);
check(
  "Vim editor doc scored higher than unrelated noise items",
  !!vimDoc && noiseItems.length > 0 && noiseItems.every((n) => (vimDoc.rerank_score as number) > (n.rerank_score as number)),
);

// ── Summary ───────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
