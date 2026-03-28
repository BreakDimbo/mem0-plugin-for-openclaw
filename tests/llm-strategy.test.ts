// ============================================================================
// Tests: LLM strategy correctness
//   - Fix 2: buildCandidateContextText — context enrichment for LLM gate
//   - Fix 3: consolidation buildPrompt includes "merge" verdict
//   - Fix 4+5: resolveCaptureRouting — captureHint / queryType routing logic
// Run with: npx tsx tests/llm-strategy.test.ts
// ============================================================================

import { buildCandidateContextText, resolveCaptureRouting } from "../core-admission.js";
import { buildPrompt } from "../consolidation/llm-consolidator.js";
import type { ClassificationResult } from "../types.js";

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function classification(
  queryType: ClassificationResult["queryType"],
  captureHint: ClassificationResult["captureHint"],
): ClassificationResult {
  return { tier: "MEDIUM", queryType, targetCategories: [], captureHint };
}

console.log("\nLLM Strategy Tests\n");

// ── Fix 2: buildCandidateContextText ─────────────────────────────────────────

await test("single user message → returned as-is (no [user] prefix)", () => {
  const msgs = [{ role: "user", content: "我平时用 vim" }];
  const result = buildCandidateContextText(msgs);
  assertEqual(result, "我平时用 vim", "single message returned verbatim");
});

await test("user message with preceding assistant turn → includes [assistant] context", () => {
  const msgs = [
    { role: "assistant", content: "你用什么编辑器？" },
    { role: "user", content: "就用 vim 吧" },
  ];
  const result = buildCandidateContextText(msgs);
  assert(result.includes("[assistant] 你用什么编辑器？"), "includes assistant context");
  assert(result.includes("[user] 就用 vim 吧"), "includes user message with prefix");
});

await test("includes up to 2 preceding turns, skips older turns", () => {
  const msgs = [
    { role: "user", content: "turn-1-old" },
    { role: "assistant", content: "turn-2-old" },
    { role: "user", content: "turn-3" },
    { role: "assistant", content: "turn-4" },
    { role: "user", content: "turn-5-target" },
  ];
  const result = buildCandidateContextText(msgs, 2);
  assert(!result.includes("turn-1-old"), "turn 1 excluded (> maxContextTurns)");
  assert(!result.includes("turn-2-old"), "turn 2 excluded (> maxContextTurns)");
  assert(result.includes("[user] turn-3"), "turn 3 included");
  assert(result.includes("[assistant] turn-4"), "turn 4 included");
  assert(result.includes("[user] turn-5-target"), "target message included");
});

await test("assistant content longer than 300 chars is truncated in context", () => {
  const longContent = "x".repeat(500);
  const msgs = [
    { role: "assistant", content: longContent },
    { role: "user", content: "短回复" },
  ];
  const result = buildCandidateContextText(msgs);
  const assistantLine = result.split("\n").find((l) => l.startsWith("[assistant]"))!;
  assert(assistantLine.length <= "[assistant] ".length + 300 + 5, "assistant content truncated at 300");
});

await test("no user message → returns empty string", () => {
  const msgs = [{ role: "assistant", content: "assistant only" }];
  const result = buildCandidateContextText(msgs);
  assertEqual(result, "", "empty string when no user message");
});

await test("empty messages array → returns empty string", () => {
  const result = buildCandidateContextText([]);
  assertEqual(result, "", "empty string for empty array");
});

// ── Fix 3: consolidation buildPrompt contains merge ──────────────────────────

await test("consolidation buildPrompt lists 'merge' as a valid verdict", () => {
  const prompt = buildPrompt([]);
  assert(prompt.includes('"merge"'), "prompt contains \"merge\" verdict");
  // Ensure it's in the Verdicts section (before the instruction line)
  const mergeIdx = prompt.indexOf('"merge"');
  const forMergeIdx = prompt.indexOf("For \"merge\" entries");
  assert(mergeIdx < forMergeIdx, '"merge" verdict listed before the instruction about it');
});

await test("consolidation buildPrompt lists all 5 verdicts", () => {
  const prompt = buildPrompt([]);
  for (const v of ["keep", "downgrade", "merge", "archive", "delete"]) {
    assert(prompt.includes(`"${v}"`), `prompt contains "${v}"`);
  }
});

// ── Fix 4+5: resolveCaptureRouting ───────────────────────────────────────────

await test("captureHint=skip → skipCapture=true, skipLlmGate=true", () => {
  const { skipCapture, skipLlmGate } = resolveCaptureRouting(classification("code", "skip"));
  assert(skipCapture, "skipCapture=true for hint=skip");
  assert(skipLlmGate, "skipLlmGate=true for hint=skip");
});

await test("captureHint=light → skipCapture=false, skipLlmGate=true", () => {
  const { skipCapture, skipLlmGate } = resolveCaptureRouting(classification("code", "light"));
  assert(!skipCapture, "skipCapture=false for hint=light (still captures free-text)");
  assert(skipLlmGate, "skipLlmGate=true for hint=light (bypasses LLM gate)");
});

await test("captureHint=full → skipCapture=false, skipLlmGate=false", () => {
  const { skipCapture, skipLlmGate } = resolveCaptureRouting(classification("open", "full"));
  assert(!skipCapture, "skipCapture=false for hint=full");
  assert(!skipLlmGate, "skipLlmGate=false for hint=full (goes through LLM gate)");
});

await test("queryType=greeting → skipCapture=true regardless of captureHint", () => {
  const { skipCapture } = resolveCaptureRouting(classification("greeting", "full"));
  assert(skipCapture, "greeting always skips capture");
});

await test("code queryType with hint=full → goes through LLM gate (no special bypass)", () => {
  const { skipCapture, skipLlmGate } = resolveCaptureRouting(classification("code", "full"));
  assert(!skipCapture, "code+full → not skipped");
  assert(!skipLlmGate, "code+full → goes through LLM gate");
});

await test("debug queryType with hint=full → goes through LLM gate", () => {
  const { skipCapture, skipLlmGate } = resolveCaptureRouting(classification("debug", "full"));
  assert(!skipCapture, "debug+full → not skipped");
  assert(!skipLlmGate, "debug+full → goes through LLM gate");
});

await test("undefined classification → skipCapture=false, skipLlmGate=false", () => {
  const { skipCapture, skipLlmGate } = resolveCaptureRouting(undefined);
  assert(!skipCapture, "undefined → not skipped");
  assert(!skipLlmGate, "undefined → goes through LLM gate");
});

// Summary
console.log();
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
