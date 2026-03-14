import { buildFreeTextMetadata, inferFreeTextMemoryKind, inferQuality, matchesMetadataFilters, metadataKindLabel } from "../metadata.js";

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

await test("inferQuality marks benchmark chatter as transient", () => {
  assertEqual(inferQuality("This is a benchmark smoke test record."), "transient", "quality");
});

await test("buildFreeTextMetadata includes scope and durable kind", () => {
  const metadata = buildFreeTextMetadata("The user prefers concise bullet summaries.", {
    userId: "alice",
    agentId: "researcher",
    sessionKey: "agent:researcher:main",
  }, { captureKind: "explicit" });

  assertEqual(metadata.source, "memory-memu", "source");
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

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
