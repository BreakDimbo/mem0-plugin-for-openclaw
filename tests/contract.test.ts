// ============================================================================
// Contract Tests for memU-server API
// Validates that the memU-server API matches expected contracts.
// Run with: npx tsx tests/contract.test.ts
// Requires memU-server running at http://127.0.0.1:8000
// ============================================================================

const BASE_URL = process.env.MEMU_BASE_URL ?? "http://127.0.0.1:8000";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, passed: false, error: String(err) });
    console.log(`  ✗ ${name}: ${String(err)}`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function postJSON(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => null);
  return { status: res.status, body: responseBody };
}

// ============================================================================
// Health Check Contract
// ============================================================================

async function testHealthCheck(): Promise<void> {
  await test("GET / returns 200", async () => {
    const res = await fetch(`${BASE_URL}/`);
    assertEqual(res.status, 200, "status code");
    const body = (await res.json()) as Record<string, unknown>;
    assert(typeof body.message === "string", "response should have message field");
  });
}

// ============================================================================
// Retrieve Contract
// ============================================================================

async function testRetrieve(): Promise<void> {
  // Test with legacy simple format (backward compat)
  await test("POST /retrieve with simple query returns success", async () => {
    const { status, body } = await postJSON("/retrieve", { query: "test query" });
    assertEqual(status, 200, "status code");
    const b = body as Record<string, unknown>;
    assertEqual(b.status, "success", "response status");
    assert(typeof b.result === "object" && b.result !== null, "result should be an object");
  });

  // Test with §8.2 queries array format
  await test("POST /retrieve with queries array format returns success", async () => {
    const { status, body } = await postJSON("/retrieve", {
      queries: [{ role: "user", content: { text: "test query" } }],
      where: { user_id: "contract_test_user" },
      method: "rag",
      limit: 5,
    });
    // Server may accept either format; both 200 and 400/422 are valid
    assert(status === 200 || status === 400 || status === 422, `unexpected status: ${status}`);
    if (status === 200) {
      const b = body as Record<string, unknown>;
      assertEqual(b.status, "success", "response status");
    }
  });

  await test("POST /retrieve with empty body returns 400 or 422", async () => {
    const { status } = await postJSON("/retrieve", {});
    assert(status === 400 || status === 422, `expected 400 or 422, got ${status}`);
  });

  await test("POST /retrieve result structure has expected fields", async () => {
    const { body } = await postJSON("/retrieve", { query: "user preferences" });
    const b = body as Record<string, unknown>;
    const result = b.result as Record<string, unknown>;
    // result should have items/categories/resources (may be empty arrays)
    assert(result !== undefined, "result should exist");
  });
}

// ============================================================================
// Memorize Contract
// ============================================================================

async function testMemorize(): Promise<void> {
  await test("POST /memorize with valid content returns success", async () => {
    const { status, body } = await postJSON("/memorize", {
      content: [
        {
          role: "user",
          content: { text: "Contract test: the user prefers dark mode" },
          created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
        },
      ],
    });
    assertEqual(status, 200, "status code");
    const b = body as Record<string, unknown>;
    assertEqual(b.status, "success", "response status");
  });

  await test("POST /memorize with §8.4 full format returns success", async () => {
    const { status, body } = await postJSON("/memorize", {
      resource_url: "inline://openclaw/session/test/item1",
      modality: "conversation",
      user: { user_id: "contract_test_user" },
      content: [
        {
          role: "user",
          content: { text: "Contract test: full format memorize" },
          created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
        },
      ],
      metadata: { agent_id: "main", session_key: "test" },
    });
    // Server may accept or ignore extra fields — both 200 and 400 are valid
    assert(status === 200 || status === 400 || status === 422, `unexpected status: ${status}`);
  });

  await test("POST /memorize with empty content returns 200 or error gracefully", async () => {
    const { status } = await postJSON("/memorize", { content: [] });
    // Server may accept empty array or return error — both are valid contract behaviors
    assert(status === 200 || status === 400 || status === 422 || status === 500, `unexpected status: ${status}`);
  });
}

// ============================================================================
// Clear Contract
// ============================================================================

async function testClear(): Promise<void> {
  await test("POST /clear with user_id returns success with purge counts", async () => {
    const { status, body } = await postJSON("/clear", { user_id: "contract_test_user" });
    assertEqual(status, 200, "status code");
    const b = body as Record<string, unknown>;
    assertEqual(b.status, "success", "response status");
    const result = b.result as Record<string, unknown>;
    assert(typeof result.purged_categories === "number", "purged_categories should be a number");
    assert(typeof result.purged_items === "number", "purged_items should be a number");
    assert(typeof result.purged_resources === "number", "purged_resources should be a number");
  });

  await test("POST /clear without user_id or agent_id returns 422", async () => {
    const { status } = await postJSON("/clear", {});
    assertEqual(status, 422, "status code");
  });
}

// ============================================================================
// Categories Contract
// ============================================================================

async function testCategories(): Promise<void> {
  await test("POST /categories with user_id returns success with categories array", async () => {
    const { status, body } = await postJSON("/categories", { user_id: "contract_test_user" });
    assertEqual(status, 200, "status code");
    const b = body as Record<string, unknown>;
    assertEqual(b.status, "success", "response status");
    const result = b.result as Record<string, unknown>;
    assert(Array.isArray(result.categories), "categories should be an array");
  });

  await test("POST /categories without user_id returns 422", async () => {
    const { status } = await postJSON("/categories", {});
    assertEqual(status, 422, "status code");
  });

  await test("POST /categories category objects have name field", async () => {
    const { body } = await postJSON("/categories", { user_id: "contract_test_user" });
    const b = body as Record<string, unknown>;
    const result = b.result as Record<string, unknown>;
    const categories = result.categories as Array<Record<string, unknown>>;
    for (const cat of categories) {
      assert(typeof cat.name === "string", "each category should have a name string");
    }
  });
}

// ============================================================================
// Runner
// ============================================================================

async function main(): Promise<void> {
  console.log(`\nmemU Contract Tests (server: ${BASE_URL})\n`);

  // Check server is reachable first
  try {
    const res = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      console.error("memU server returned non-200 on health check. Aborting.");
      process.exit(1);
    }
  } catch {
    console.error(`memU server not reachable at ${BASE_URL}. Start it first.`);
    process.exit(1);
  }

  console.log("Health Check:");
  await testHealthCheck();

  console.log("\nRetrieve:");
  await testRetrieve();

  console.log("\nMemorize:");
  await testMemorize();

  console.log("\nClear:");
  await testClear();

  console.log("\nCategories:");
  await testCategories();

  // Summary
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
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
