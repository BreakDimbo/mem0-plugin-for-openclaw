// ============================================================================
// Live E2E Lifecycle Test: real OpenClaw agent + memory-mem0 plugin
//
// Tests the full capture → persist → recall pipeline against a live agent.
//
// Architecture notes (from debugging):
// - Agent uses memory_store tool → outbox auto-flush → mem0 → Qdrant
// - mem0 condenses/translates content (e.g., "bouldering" → "抱石")
// - Core extraction via message_received hook does NOT fire in CLI mode
// - Recall hook prioritizes core memory (always-inject tiers) over free-text
// - mem0 processing + Qdrant indexing requires ~30s latency
//
// Run:  npx tsx scripts/run-e2e-lifecycle-live.ts
// ============================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const AGENT_ID = process.env.BENCHMARK_AGENT_ID || "main";
const SESSION_KEY = `agent:${AGENT_ID}:main`;
const CWD = "/Users/Break/.openclaw";

type StepResult = { name: string; passed: boolean; detail: string; durationMs: number };
const results: StepResult[] = [];

// ── OpenClaw helpers ─────────────────────────────────────────────────────────

async function resetSession(reason: "new" | "reset"): Promise<void> {
  await execFileAsync(
    OPENCLAW_BIN,
    ["gateway", "call", "sessions.reset", "--json", "--timeout", "20000", "--params", JSON.stringify({ key: SESSION_KEY, reason })],
    { cwd: CWD, maxBuffer: 2 * 1024 * 1024 },
  );
}

async function sendMessage(message: string): Promise<string> {
  const { stdout } = await execFileAsync(
    OPENCLAW_BIN,
    ["agent", "--agent", AGENT_ID, "--message", message, "--timeout", "60", "--json"],
    { cwd: CWD, maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(extractTrailingJson(stdout));
  return String(parsed?.result?.payloads?.[0]?.text ?? "").trim();
}

function extractTrailingJson(stdout: string): string {
  const firstBrace = stdout.indexOf("{");
  if (firstBrace >= 0) {
    const candidate = extractBalancedJson(stdout.slice(firstBrace).trim());
    if (candidate) return candidate;
  }
  for (let start = stdout.lastIndexOf("{"); start >= 0; start = stdout.lastIndexOf("{", start - 1)) {
    const candidate = extractBalancedJson(stdout.slice(start).trim());
    if (candidate) return candidate;
  }
  throw new Error(`No JSON payload found in output: ${stdout.slice(0, 200)}`);
}

function extractBalancedJson(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) { escaped = false; } else if (char === "\\") { escaped = true; } else if (char === '"') { inString = false; }
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") { depth++; continue; }
    if (char === "}") { depth--; if (depth === 0) return text.slice(0, i + 1); }
  }
  return null;
}

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  const start = Date.now();
  try {
    const detail = await fn();
    const durationMs = Date.now() - start;
    results.push({ name, passed: true, detail, durationMs });
    console.log(`  ✓ ${name} (${durationMs}ms)`);
    if (detail) console.log(`    ${detail.slice(0, 300)}`);
  } catch (err) {
    const durationMs = Date.now() - start;
    results.push({ name, passed: false, detail: String(err), durationMs });
    console.log(`  ✗ ${name} (${durationMs}ms): ${String(err).slice(0, 300)}`);
  }
}

function containsAny(text: string, ...terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((t) => lower.includes(t.toLowerCase()));
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log("\n🔬 Live E2E Lifecycle Test (OpenClaw + memory-mem0)\n");
console.log(`  Agent: ${AGENT_ID}`);
console.log("");

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1: Capture — send unique facts the agent should memorize
// ═══════════════════════════════════════════════════════════════════════════════

await step("1. Reset session", async () => {
  await resetSession("reset");
  return "OK";
});

await step("2. Store hobby: bouldering", async () => {
  const reply = await sendMessage("my favorite hobby is bouldering and climbing walls");
  if (!containsAny(reply, "bouldering", "抱石", "攀岩", "记住", "记下", "noted", "got it"))
    throw new Error(`Agent didn't acknowledge: ${reply}`);
  return `Agent: ${reply.slice(0, 150)}`;
});

await step("3. Store pet: golden retriever Apollo", async () => {
  const reply = await sendMessage("I have a golden retriever named Apollo");
  if (!containsAny(reply, "apollo", "金毛", "retriever", "记住", "记下", "noted", "got it"))
    throw new Error(`Agent didn't acknowledge: ${reply}`);
  return `Agent: ${reply.slice(0, 150)}`;
});

await step("4. Store beverage: oat milk latte", async () => {
  const reply = await sendMessage("I drink oat milk latte every single morning without exception");
  if (!containsAny(reply, "oat", "燕麦", "latte", "拿铁", "记住", "记下", "noted", "got it"))
    throw new Error(`Agent didn't acknowledge: ${reply}`);
  return `Agent: ${reply.slice(0, 150)}`;
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 2: Wait for async pipeline
//   memory_store tool → outbox auto-flush (10s) → mem0 API → Qdrant indexing
// ═══════════════════════════════════════════════════════════════════════════════

const WAIT_SECONDS = 30;
console.log(`  ⏳ Waiting ${WAIT_SECONDS}s for outbox flush + mem0 processing + Qdrant indexing...`);
await new Promise((r) => setTimeout(r, WAIT_SECONDS * 1000));

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 3: Verify — new session (clean context), explicitly use recall tool
// ═══════════════════════════════════════════════════════════════════════════════

await step("5. Reset session (verify phase)", async () => {
  await resetSession("new");
  return "OK";
});

// Search for each fact explicitly using the memory_recall tool.
// This tests: outbox → mem0 store → Qdrant indexing → recall tool search

await step("6. Verify: search for Apollo", async () => {
  const reply = await sendMessage(
    `Use the memory_recall tool to search for "golden retriever Apollo". List all results found.`,
  );
  if (!containsAny(reply, "apollo", "金毛", "retriever"))
    throw new Error(`Apollo not found in free-text search: ${reply}`);
  return `Found: ${reply.slice(0, 250)}`;
});

// Small delay to avoid API rate limits between search-heavy requests
await new Promise((r) => setTimeout(r, 5_000));

await step("7. Verify: search for bouldering", async () => {
  const reply = await sendMessage(
    `Use the memory_recall tool to search for "bouldering climbing hobby". List all results found.`,
  );
  if (!containsAny(reply, "bouldering", "抱石", "攀岩", "climbing"))
    throw new Error(`Bouldering not found in free-text search: ${reply}`);
  return `Found: ${reply.slice(0, 250)}`;
});

await new Promise((r) => setTimeout(r, 5_000));

await step("8. Verify: search for oat latte", async () => {
  const reply = await sendMessage(
    `Use the memory_recall tool to search for "oat milk latte morning". List all results found.`,
  );
  if (!containsAny(reply, "oat", "燕麦", "latte", "拿铁"))
    throw new Error(`Oat latte not found in free-text search: ${reply}`);
  return `Found: ${reply.slice(0, 250)}`;
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 4: Recall — new session, natural conversation recall
//   Tests: before_prompt_build hook → query extraction → free-text search → injection
// ═══════════════════════════════════════════════════════════════════════════════

await step("9. Reset session (recall phase)", async () => {
  await resetSession("new");
  return "OK";
});

// Ask about stored facts. The recall hook auto-injects at before_prompt_build,
// but relevance scoring may not surface all facts. The agent should also use
// the memory_recall tool when explicitly asked to check memories.

await step("10. Recall: pet name", async () => {
  const reply = await sendMessage("Do you remember my pet's name? Use your memory tools if needed.");
  if (!containsAny(reply, "apollo", "金毛", "retriever"))
    throw new Error(`Expected Apollo/金毛 in reply: ${reply}`);
  return `✓ ${reply.slice(0, 200)}`;
});

await new Promise((r) => setTimeout(r, 3_000));

await step("11. Recall: morning drink", async () => {
  const reply = await sendMessage("What do I drink every morning? Use the memory_recall tool to check.");
  if (!containsAny(reply, "oat", "燕麦", "latte", "拿铁"))
    throw new Error(`Expected oat latte in reply: ${reply}`);
  return `✓ ${reply.slice(0, 200)}`;
});

await new Promise((r) => setTimeout(r, 3_000));

await step("12. Recall: hobby", async () => {
  const reply = await sendMessage("What is my favorite hobby? Use the memory_recall tool to check.");
  if (!containsAny(reply, "bouldering", "抱石", "攀岩", "climbing"))
    throw new Error(`Expected bouldering in reply: ${reply}`);
  return `✓ ${reply.slice(0, 200)}`;
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 5: Core memory (informational — extraction doesn't fire in CLI mode)
// ═══════════════════════════════════════════════════════════════════════════════

await step("13. Core memory summary", async () => {
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile("/Users/Break/.openclaw/data/memory-memu/core-memory.json", "utf-8");
    const data = JSON.parse(raw);
    const items = data.items ?? [];
    const cats = new Map<string, number>();
    for (const it of items) cats.set(it.category || "general", (cats.get(it.category || "general") || 0) + 1);
    return `Core: ${items.length} items (${[...cats.entries()].map(([k, v]) => `${k}=${v}`).join(", ")})`;
  } catch {
    return "No core memory file";
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const totalMs = results.reduce((s, r) => s + r.durationMs, 0);

console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
console.log(`Total time: ${(totalMs / 1000).toFixed(1)}s`);

if (failed > 0) {
  console.log("\nFailed steps:");
  for (const r of results.filter((r) => !r.passed)) {
    console.log(`  ✗ ${r.name}: ${r.detail.slice(0, 300)}`);
  }
  process.exit(1);
}

console.log("\n✅ All steps passed!\n");
