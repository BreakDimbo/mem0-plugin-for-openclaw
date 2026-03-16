import { CHINESE_BENCHMARK_CASES } from "../scripts/chinese-query-fixtures.js";
import { inferFreeTextMemoryKind, inferQueryKindHints, rerankMemoryResults } from "../metadata.js";

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

console.log("\nChinese Query Fixture Tests\n");

await test("fixture list includes 20 Chinese business queries", () => {
  assertEqual(CHINESE_BENCHMARK_CASES.length, 20, "fixture count");
});

await test("Chinese package manager fact is classified as tooling", () => {
  const item = CHINESE_BENCHMARK_CASES.find((row) => row.id === "zh09");
  assert(!!item, "missing zh09");
  assertEqual(inferFreeTextMemoryKind(item!.fact), "tooling", "zh09 kind");
});

await test("Chinese query hints recognize preference and tooling intents", () => {
  const prefHints = inferQueryKindHints("用户偏好喝什么饮料？");
  const toolHints = inferQueryKindHints("用户更喜欢用什么包管理工具？");
  assert(prefHints.includes("preference"), "preference hint");
  assert(toolHints.includes("tooling"), "tooling hint");
});

await test("Chinese reranker promotes matching durable fact", () => {
  const scope = { userId: "u", agentId: "a", sessionKey: "s" };
  const ranked = rerankMemoryResults("用户更喜欢用什么包管理工具？", [
    {
      id: "a",
      text: "用户偏好使用 pnpm 作为 JavaScript 包管理工具。",
      category: "general",
      source: "memu_item" as const,
      scope,
      score: 0.78,
      metadata: { quality: "durable", memory_kind: "tooling", capture_kind: "explicit" },
    },
    {
      id: "b",
      text: "用户更喜欢茉莉花茶而不是咖啡。",
      category: "general",
      source: "memu_item" as const,
      scope,
      score: 0.82,
      metadata: { quality: "durable", memory_kind: "preference", capture_kind: "explicit" },
    },
  ]);

  assertEqual(ranked[0]?.id, "a", "tooling fact should rank first");
});

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
