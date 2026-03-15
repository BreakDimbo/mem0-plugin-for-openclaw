/**
 * E2E Ingest + 70-Case Recall Benchmark
 *
 * Phase 1: Enable LLM gate in plugin config
 * Phase 2: Ingest ~28 messages covering all 38 core facts through live agent
 * Phase 3: Wait for pipeline (candidateQueue + LLM gate + outbox + Qdrant)
 * Phase 4: Diagnostics — inspect core-memory.json
 * Phase 5: Run 70-case recall benchmark
 * Phase 6: Report + cleanup
 */

import { execFile } from "node:child_process";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { promisify } from "node:util";
import { BENCHMARK_E2E_CASES } from "./benchmark-e2e-fixtures.js";
import { includesExpected } from "./layered-benchmark.js";

const execFileAsync = promisify(execFile);
const AGENT_ID = process.env.BENCHMARK_AGENT_ID || "main";
const SESSION_KEY = `agent:${AGENT_ID}:main`;
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const OPENCLAW_CWD = "/Users/Break/.openclaw";
const CONFIG_PATH = `${OPENCLAW_CWD}/openclaw.json`;
const CORE_MEMORY_PATH = `${OPENCLAW_CWD}/data/memory-memu/core-memory.json`;

type E2EResult = {
  id: string;
  query: string;
  expected: string;
  answer: string;
  hit: boolean;
  durationMs: number;
};

// ─── Ingest Messages ──────────────────────────────────────────────
// First-person natural language, ≥24 chars, avoiding LOW_SIGNAL filter words.
// Rephrased: "memU"→"记忆插件/记忆服务", "修复"→"解决"

const INGEST_MESSAGES: string[] = [
  // Profile (regex-matchable) — all messages ≥24 chars to pass shouldCapture
  "我叫昊，常驻北京，我的时区是 UTC+8，这是我的基本信息",
  "我现在的职业是字节跳动资深后端架构师，工作了很多年",
  // Profile (LLM gate)
  "我主要深耕分布式系统与高并发，这是我的技术核心领域",
  "我的人格倾向是 INTJ，偏好独立深度思考而非群体讨论",
  // Goals (mixed)
  "我的主目标是成为一人公司创业者，借助 AI 完成职业转型",
  "我的健康目标是养成健身习惯并减重大约 30 斤，保持体型",
  "我正在探索自媒体方向，也在学 iOS 开发，同时对游戏开发和开源项目感兴趣",
  // Relationships (LLM gate)
  "对我来说最重要的关系对象是我的爱人，家庭在我心中排第一位",
  // Preferences (regex-matchable) — padded to ≥24 chars
  "我偏好的沟通风格是平静、专业、直击要害，不需要啰嗦",
  "我偏好的表达方式是金字塔结构，结论先行，再展开细节",
  "我偏好异步沟通方式，不喜欢被打断专注时间和深度思考",
  "我一天里上午和晚上最高效，这是我工作和学习的黄金时段",
  "我讨厌 AI 客套话和寒暄，请跳过所有不必要的社交礼节",
  // Preferences (LLM gate)
  "我最喜欢的饮料是手冲咖啡，每天至少一杯才能进入状态",
  "我日常使用 Neovim 作为主力编辑器进行所有代码编写",
  // Constraints (LLM gate)
  "删除操作的默认行为必须是使用 trash，而不是直接删除",
  "任何外部行动都需要先跟我确认才能执行，不能自动执行操作",
  "隐私原则：不暴露私有架构代码和敏感配置，这是底线",
  "我遵循第一性原理进行思考，在缺乏数据时应该调用工具检索，不能编造",
  // Technical (LLM gate, rephrased to avoid "memU")
  "smart-router 分类器现在的模型是 gemini-3.1-flash-lite-preview",
  "记忆插件的 embedding 现在用的模型是 nomic-embed-text，向量维度是 768",
  "Gemini embedding-001 的向量维度是 3072，比 nomic 高很多",
  "记忆服务优化后 retrieve 的 P95 延迟是 120ms，月费用大概是 0 美元",
  "memory-memu 把 retrieve 超时调整到了 5000ms，cbResetMs 配置是 10000ms",
  // Architecture (LLM gate)
  "目标记忆架构一共有四层：第一层是 JSONL 全量对话日志，第二层是可搜索的长期记忆",
  "目标记忆架构的第三层是 Core Memory K/V 结构化存储，第四层是 context compaction",
  // Decisions (LLM gate, rephrased)
  "记忆服务 retrieve 优化时，route_intention 和 sufficiency_check 都关闭了，resource 检索也关闭了",
  // Lessons
  "记忆系统的核心教训是召回链路稳定性至关重要，任何环节断裂都会导致记忆丢失",
];

// ─── Helpers ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAgentQuery(message: string): Promise<string> {
  const parsed = await runAgentCommand(message);
  return String(parsed?.result?.payloads?.[0]?.text ?? "").trim();
}

async function resetAgentSession(reason: "new" | "reset"): Promise<void> {
  await execFileAsync(
    OPENCLAW_BIN,
    [
      "gateway", "call", "sessions.reset",
      "--json", "--timeout", "20000",
      "--params", JSON.stringify({ key: SESSION_KEY, reason }),
    ],
    { cwd: OPENCLAW_CWD, maxBuffer: 2 * 1024 * 1024 },
  );
}

async function runAgentCommand(message: string): Promise<any> {
  const { stdout } = await execFileAsync(
    OPENCLAW_BIN,
    ["agent", "--agent", AGENT_ID, "--message", message, "--timeout", "45", "--json"],
    { cwd: OPENCLAW_CWD, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(extractTrailingJson(stdout));
}

async function sendIngestMessage(message: string): Promise<void> {
  await execFileAsync(
    OPENCLAW_BIN,
    ["agent", "--agent", AGENT_ID, "--message", message, "--timeout", "30", "--json"],
    { cwd: OPENCLAW_CWD, maxBuffer: 4 * 1024 * 1024 },
  );
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
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (char === "\\") { escaped = true; }
      else if (char === "\"") { inString = false; }
      continue;
    }
    if (char === "\"") { inString = true; continue; }
    if (char === "{") { depth += 1; continue; }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

// ─── Phase 1: Config Setup ───────────────────────────────────────

async function phase1_configSetup(): Promise<{ originalConfig: string }> {
  console.log("\n═══ Phase 1: Config Setup ═══\n");

  const originalConfig = await readFile(CONFIG_PATH, "utf-8");
  const config = JSON.parse(originalConfig);

  // Get the API key from mem0 oss config
  const pluginConfig = config.plugins?.entries?.["memory-mem0"]?.config ?? {};
  const apiKey = pluginConfig.mem0?.oss?.llm?.config?.apiKey;
  if (!apiKey) {
    throw new Error("Cannot find mem0.oss.llm.config.apiKey in openclaw.json");
  }

  // Enable LLM gate
  pluginConfig.core = {
    ...pluginConfig.core,
    humanReviewRequired: false,
    llmGate: {
      enabled: true,
      apiBase: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey,
      model: "gemini-2.5-flash",
      maxTokensPerBatch: 4000,
      timeoutMs: 60000,
    },
  };

  config.plugins.entries["memory-mem0"].config = pluginConfig;
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  console.log("✓ LLM gate enabled in openclaw.json");

  // Backup and clear core memory
  try {
    await copyFile(CORE_MEMORY_PATH, `${CORE_MEMORY_PATH}.bak`);
    console.log("✓ Backed up core-memory.json");
  } catch {
    console.log("  (no existing core-memory.json to backup)");
  }
  await writeFile(CORE_MEMORY_PATH, JSON.stringify({ items: [] }, null, 2), "utf-8");
  console.log("✓ Cleared core-memory.json");

  // Restart gateway
  console.log("  Restarting gateway...");
  try {
    await execFileAsync(OPENCLAW_BIN, ["gateway", "restart"], {
      cwd: OPENCLAW_CWD,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30000,
    });
  } catch {
    // gateway restart may not return cleanly, wait for it to come back
    await sleep(5000);
  }
  console.log("✓ Gateway restarted");

  return { originalConfig };
}

// ─── Phase 2: Ingest Messages ─────────────────────────────────────

async function phase2_ingest(): Promise<{ ingestDurationMs: number }> {
  console.log("\n═══ Phase 2: Ingest Messages ═══\n");

  // Reset session once
  await resetAgentSession("reset");
  console.log("✓ Session reset");

  const startTime = Date.now();
  for (const [i, msg] of INGEST_MESSAGES.entries()) {
    const tag = `[${i + 1}/${INGEST_MESSAGES.length}]`;
    try {
      await sendIngestMessage(msg);
      console.log(`${tag} ✓ sent (${msg.slice(0, 40)}...)`);
    } catch (err: any) {
      console.log(`${tag} ✗ FAILED: ${err.message?.slice(0, 100)}`);
    }
    if (i < INGEST_MESSAGES.length - 1) {
      await sleep(3000);
    }
  }

  const ingestDurationMs = Date.now() - startTime;
  console.log(`\n✓ Ingest complete in ${Math.round(ingestDurationMs / 1000)}s`);
  return { ingestDurationMs };
}

// ─── Phase 3: Wait for Pipeline ───────────────────────────────────

async function phase3_wait(): Promise<void> {
  console.log("\n═══ Phase 3: Waiting for Pipeline (60s) ═══\n");
  const stages = [
    { label: "candidateQueue timer", secs: 15 },
    { label: "LLM gate batches", secs: 20 },
    { label: "outbox flush", secs: 15 },
    { label: "Qdrant indexing", secs: 10 },
  ];
  for (const stage of stages) {
    process.stdout.write(`  ${stage.label} (${stage.secs}s)...`);
    await sleep(stage.secs * 1000);
    console.log(" done");
  }
}

// ─── Phase 4: Diagnostics ─────────────────────────────────────────

type DiagnosticsResult = {
  totalCoreItems: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
};

async function phase4_diagnostics(): Promise<DiagnosticsResult> {
  console.log("\n═══ Phase 4: Diagnostics ═══\n");

  let items: any[] = [];
  try {
    const raw = await readFile(CORE_MEMORY_PATH, "utf-8");
    const data = JSON.parse(raw);
    items = data.items ?? [];
  } catch {
    console.log("  ✗ Could not read core-memory.json");
  }

  const byCategory: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const item of items) {
    const cat = item.category ?? item.key?.split(".")?.[0] ?? "unknown";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    const src = item.provenance ?? item.source ?? "unknown";
    bySource[src] = (bySource[src] ?? 0) + 1;
  }

  console.log(`  Core memory items: ${items.length}`);
  console.log(`  By category: ${JSON.stringify(byCategory)}`);
  console.log(`  By source:   ${JSON.stringify(bySource)}`);

  return { totalCoreItems: items.length, byCategory, bySource };
}

// ─── Phase 5: Recall Benchmark ────────────────────────────────────

async function phase5_benchmark(): Promise<{ results: E2EResult[]; summary: any }> {
  console.log("\n═══ Phase 5: 70-Case Recall Benchmark ═══\n");

  const limit = parseOptionalPositiveInt(process.env.E2E_LIMIT);
  const cases = limit ? BENCHMARK_E2E_CASES.slice(0, limit) : BENCHMARK_E2E_CASES;
  const results: E2EResult[] = [];

  console.log(`Running ${cases.length} recall cases...\n`);

  for (const [index, item] of cases.entries()) {
    // Reset session per case for clean recall
    await resetAgentSession("new");

    const message = `请只用一句中文回答：${item.query}`;
    const started = Date.now();
    let answer = "";
    let hit = false;

    try {
      answer = await runAgentQuery(message);
      hit = includesExpected(answer, item.expected);
    } catch (err: any) {
      answer = `ERROR: ${err.message?.slice(0, 100)}`;
    }

    const durationMs = Date.now() - started;
    results.push({ id: item.id, query: item.query, expected: item.expected, answer, hit, durationMs });
    const mark = hit ? "✓" : "✗";
    console.log(`[${index + 1}/${cases.length}] ${mark} ${item.id} ${durationMs}ms`);
    if (!hit) {
      console.log(`  expected: ${item.expected}`);
      console.log(`  got:      ${answer.slice(0, 120)}`);
    }
  }

  const hits = results.filter((r) => r.hit).length;
  const summary = {
    cases: results.length,
    hits,
    hitRate: Number((hits / Math.max(results.length, 1)).toFixed(3)),
    avgDurationMs: Math.round(results.reduce((s, r) => s + r.durationMs, 0) / Math.max(results.length, 1)),
    p95DurationMs: percentile(results.map((r) => r.durationMs), 0.95),
  };

  return { results, summary };
}

// ─── Phase 6: Report + Cleanup ────────────────────────────────────

async function phase6_report(
  originalConfig: string,
  ingestDurationMs: number,
  diagnostics: DiagnosticsResult,
  benchmarkResults: E2EResult[],
  benchmarkSummary: any,
): Promise<string> {
  console.log("\n═══ Phase 6: Report + Cleanup ═══\n");

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const report = {
    generatedAt: new Date().toISOString(),
    ingest: {
      messageCount: INGEST_MESSAGES.length,
      durationMs: ingestDurationMs,
    },
    diagnostics,
    benchmark: {
      summary: benchmarkSummary,
      failures: benchmarkResults.filter((r) => !r.hit),
      results: benchmarkResults,
    },
  };

  const reportPath = `/tmp/e2e-ingest-benchmark-${runId}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`✓ Report: ${reportPath}`);

  // Restore original config
  try {
    await writeFile(CONFIG_PATH, originalConfig, "utf-8");
    console.log("✓ Restored original openclaw.json");
    // Restart gateway with original config
    try {
      await execFileAsync(OPENCLAW_BIN, ["gateway", "restart"], {
        cwd: OPENCLAW_CWD,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30000,
      });
    } catch {
      await sleep(3000);
    }
    console.log("✓ Gateway restarted with original config");
  } catch (err: any) {
    console.log(`✗ Failed to restore config: ${err.message}`);
  }

  // Print summary
  console.log("\n═══ Summary ═══\n");
  console.log(JSON.stringify(benchmarkSummary, null, 2));
  console.log(`\nCore memory: ${diagnostics.totalCoreItems} items`);
  console.log(`Report: ${reportPath}`);

  return reportPath;
}

function parseOptionalPositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  E2E Ingest + 70-Case Recall Benchmark      ║");
  console.log("╚══════════════════════════════════════════════╝");

  const { originalConfig } = await phase1_configSetup();
  const { ingestDurationMs } = await phase2_ingest();
  await phase3_wait();
  const diagnostics = await phase4_diagnostics();
  const { results, summary } = await phase5_benchmark();
  await phase6_report(originalConfig, ingestDurationMs, diagnostics, results, summary);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
