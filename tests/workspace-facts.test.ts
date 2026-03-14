import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceDir, searchWorkspaceFacts } from "../workspace-facts.js";
import type { MemoryScope } from "../types.js";

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

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

console.log("\nWorkspace Facts Tests\n");

const scope: MemoryScope = {
  userId: "example_user",
  agentId: "turning_zero",
  sessionKey: "agent:turning_zero:main",
};

await test("searchWorkspaceFacts finds relevant snippets in workspace memory files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workspace-facts-"));
  try {
    await mkdir(path.join(dir, "memory"), { recursive: true });
    await writeFile(path.join(dir, "USER.md"), "# USER\n- 当前所在地: 新加坡\n", "utf8");
    await writeFile(
      path.join(dir, "memory", "2026-03-05-wechat-setup.md"),
      [
        "assistant: ✅ Obsidian Skill 已激活",
        "| Vault 名称 | 路径 | 状态 |",
        "| Obsidian Vault | ~/Documents/Obsidian Vault | 默认 + 已打开 |",
      ].join("\n"),
      "utf8",
    );

    const hits = await searchWorkspaceFacts("用户主要用什么笔记应用？", scope, dir, {
      maxItems: 2,
      maxFiles: 4,
    });

    assert(hits.length > 0, "expected at least one workspace fact");
    assert(hits.some((hit) => /obsidian/i.test(hit.text)), "expected an Obsidian-related snippet");
    assert(hits.every((hit) => hit.category === "workspace_fact"), "expected workspace_fact category");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test("searchWorkspaceFacts ignores opaque metadata-only lines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workspace-facts-"));
  try {
    await writeFile(
      path.join(dir, "MEMORY.md"),
      [
        "sender_id: om_x100b5464adbe44a8c42bfbe6c9dcd6f",
        "message_id: msg_1234567890abcdef1234567890",
      ].join("\n"),
      "utf8",
    );

    const hits = await searchWorkspaceFacts("sender 是谁？", scope, dir, {
      maxItems: 2,
      maxFiles: 2,
    });

    assert(hits.length === 0, "expected no hits from opaque metadata-only lines");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test("searchWorkspaceFacts filters snippets that only mirror the current question", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workspace-facts-"));
  try {
    await writeFile(
      path.join(dir, "MEMORY.md"),
      [
        "请只用一句中文回答：用户正在探索哪个媒体方向？",
        "用户正在探索的媒体方向是自媒体。",
      ].join("\n"),
      "utf8",
    );

    const hits = await searchWorkspaceFacts("用户正在探索哪个媒体方向？", scope, dir, {
      maxItems: 3,
      maxFiles: 2,
    });

    assert(hits.length > 0, "expected factual workspace hit");
    assert(hits.every((hit) => !hit.text.includes("请只用一句中文回答")), "should drop mirrored query snippets");
    assert(hits.some((hit) => hit.text.includes("自媒体")), "should keep actual factual snippet");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test("resolveWorkspaceDir falls back to standard OpenClaw workspace paths", () => {
  const resolved = resolveWorkspaceDir("turning_zero");
  assert(/workspace-turning_zero$/.test(resolved), "expected agent workspace suffix");
});

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) process.exit(1);
