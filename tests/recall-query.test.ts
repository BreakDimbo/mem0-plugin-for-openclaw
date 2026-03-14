import { sanitizePromptQuery, splitRecallQueries } from "../hooks/recall.js";

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
  assertEqual(parts[0], "请用三行中文回答，不要解释：1. 用户叫什么名字？2. memU embedding 现在用什么？3. 记忆系统一共有几层？", "full query retained");
  assertEqual(parts[1], "用户叫什么名字？", "question 1 extracted");
  assertEqual(parts[2], "memU embedding 现在用什么？", "question 2 extracted");
  assertEqual(parts[3], "记忆系统一共有几层？", "question 3 extracted");
});

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
