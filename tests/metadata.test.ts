import { buildFreeTextMetadata, inferFreeTextMemoryKind, inferQuality, inferQueryKindHints, matchesMetadataFilters, metadataKindLabel, rerankMemoryResults } from "../metadata.js";

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

console.log("\nMetadata Tests\n");

await test("inferFreeTextMemoryKind classifies preferences", () => {
  assertEqual(inferFreeTextMemoryKind("The user prefers jasmine tea over coffee."), "preference", "preference");
});

await test("inferFreeTextMemoryKind classifies tooling", () => {
  assertEqual(inferFreeTextMemoryKind("The user's preferred editor is Neovim."), "tooling", "tooling");
});

await test("inferFreeTextMemoryKind handles Chinese preference and tooling", () => {
  assertEqual(inferFreeTextMemoryKind("用户偏好使用 pnpm 作为 JavaScript 包管理工具。"), "tooling", "tooling zh");
  assertEqual(inferFreeTextMemoryKind("用户更喜欢茉莉花茶而不是咖啡。"), "preference", "preference zh");
});

await test("inferFreeTextMemoryKind classifies generalized long-term engineering knowledge", () => {
  assertEqual(
    inferFreeTextMemoryKind("smart-router 分类器模型是 gemini-3.1-flash-lite-preview。"),
    "technical",
    "technical kind",
  );
  assertEqual(
    inferFreeTextMemoryKind("memU retrieve 优化时 route_intention 状态为关闭。"),
    "decision",
    "decision kind",
  );
  assertEqual(
    inferFreeTextMemoryKind("目标记忆架构的第1层是 JSONL 全量对话日志。"),
    "architecture",
    "architecture kind",
  );
  assertEqual(
    inferFreeTextMemoryKind("优化后 retrieve 的 P95 延迟是 120ms。"),
    "benchmark",
    "benchmark kind",
  );
});

await test("inferQuality marks benchmark chatter as transient", () => {
  assertEqual(inferQuality("This is a benchmark smoke test record."), "transient", "quality");
});

await test("buildFreeTextMetadata includes scope and durable kind", () => {
  const metadata = buildFreeTextMetadata("The user prefers concise bullet summaries.", {
    userId: "alice",
    agentId: "researcher",
    sessionKey: "agent:researcher:main",
  }, { captureKind: "explicit" });

  assertEqual(metadata.source, "memory-mem0", "source");
  assertEqual(metadata.capture_kind, "explicit", "capture kind");
  assertEqual(metadata.memory_kind, "preference", "memory kind");
  assertEqual(metadata.quality, "durable", "quality");
  assertEqual(metadata.scope_user_id, "alice", "scope user");
});

await test("metadataKindLabel hides general kind", () => {
  assertEqual(metadataKindLabel({ memory_kind: "general" }), undefined, "general hidden");
  assertEqual(metadataKindLabel({ memory_kind: "tooling" }), "tooling", "tooling shown");
});

await test("matchesMetadataFilters accepts durable preference filters", () => {
  const passed = matchesMetadataFilters(
    { quality: "durable", memory_kind: "preference", capture_kind: "explicit" },
    { quality: "durable", memoryKinds: ["preference"], captureKind: "explicit" },
  );
  assertEqual(passed, true, "durable preference filter");
});

await test("matchesMetadataFilters rejects transient when durable required", () => {
  const passed = matchesMetadataFilters(
    { quality: "transient", memory_kind: "schedule", capture_kind: "auto" },
    { quality: "durable" },
  );
  assertEqual(passed, false, "durable filter rejects transient");
});

await test("inferQueryKindHints recognizes Chinese tooling query", () => {
  const hints = inferQueryKindHints("用户偏好用什么包管理工具？");
  assertEqual(hints.includes("tooling"), true, "tooling query hint");
});

await test("inferQueryKindHints recognizes generalized system and architecture queries", () => {
  const technical = inferQueryKindHints("smart-router 分类器现在是什么模型？");
  assertEqual(technical.includes("technical"), true, "technical query hint");

  const architecture = inferQueryKindHints("目标记忆架构的第1层是什么？");
  assertEqual(architecture.includes("architecture"), true, "architecture query hint");

  const decision = inferQueryKindHints("route_intention 为什么关闭？");
  assertEqual(decision.includes("decision"), true, "decision query hint");
});

await test("rerankMemoryResults boosts Chinese preference match over generic durable hit", () => {
  const scope = { userId: "alice", agentId: "researcher", sessionKey: "agent:researcher:main" };
  const ranked = rerankMemoryResults("用户更喜欢喝什么饮料？", [
    {
      id: "generic",
      text: "用户主要使用 Arc 浏览器。",
      category: "general",
      source: "memu_item" as const,
      scope,
      score: 0.91,
      metadata: { quality: "durable", memory_kind: "profile", capture_kind: "explicit" },
    },
    {
      id: "pref",
      text: "用户更喜欢茉莉花茶而不是咖啡。",
      category: "general",
      source: "memu_item" as const,
      scope,
      score: 0.84,
      metadata: { quality: "durable", memory_kind: "preference", capture_kind: "explicit" },
    },
  ]);
  assertEqual(ranked[0]?.id, "pref", "preference should rank first");
});

await test("rerankMemoryResults boosts Chinese editor concept over generic tooling fact", () => {
  const scope = { userId: "alice", agentId: "researcher", sessionKey: "agent:researcher:main" };
  const ranked = rerankMemoryResults("用户主要用什么编辑器？", [
    {
      id: "db",
      text: "用户主要使用 PostgreSQL 作为数据库。",
      category: "general",
      source: "memu_item" as const,
      scope,
      score: 0.9,
      metadata: { quality: "durable", memory_kind: "tooling", capture_kind: "explicit" },
    },
    {
      id: "editor",
      text: "用户主要使用 Neovim 作为编辑器。",
      category: "general",
      source: "memu_item" as const,
      scope,
      score: 0.8,
      metadata: { quality: "durable", memory_kind: "tooling", capture_kind: "explicit" },
    },
  ]);
  assertEqual(ranked[0]?.id, "editor", "editor fact should rank first");
});

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
