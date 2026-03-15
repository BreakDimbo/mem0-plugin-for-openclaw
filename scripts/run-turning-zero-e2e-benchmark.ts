import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { BENCHMARK_E2E_CASES } from "./benchmark-e2e-fixtures.js";
import { includesExpected } from "./layered-benchmark.js";

const execFileAsync = promisify(execFile);
const AGENT_ID = process.env.BENCHMARK_AGENT_ID || "main";
const SESSION_KEY = `agent:${AGENT_ID}:main`;

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";

type E2EResult = {
  id: string;
  query: string;
  expected: string;
  answer: string;
  hit: boolean;
  durationMs: number;
};


async function main() {
  const limit = parseOptionalPositiveInt(process.env.E2E_LIMIT);
  const resetPerCase = process.env.BENCHMARK_RESET_SESSION !== "0";
  const cases = limit ? BENCHMARK_E2E_CASES.slice(0, limit) : BENCHMARK_E2E_CASES;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const results: E2EResult[] = [];

  console.log(`Running ${cases.length} live end-to-end recall cases...`);
  await resetAgentSession("reset");
  for (const [index, item] of cases.entries()) {
    if (resetPerCase) {
      await resetAgentSession("new");
    }
    const message = `请只用一句中文回答：${item.query}`;
    const started = Date.now();
    const answer = await runAgentQuery(message);
    const durationMs = Date.now() - started;
    const hit = includesExpected(answer, item.expected);
    results.push({ id: item.id, query: item.query, expected: item.expected, answer, hit, durationMs });
    console.log(`[${index + 1}/${cases.length}] ${item.id} hit=${hit ? "Y" : "N"} ${durationMs}ms`);
  }

  const summary = {
    cases: results.length,
    hits: results.filter((row) => row.hit).length,
    hitRate: Number((results.filter((row) => row.hit).length / results.length).toFixed(3)),
    avgDurationMs: Math.round(results.reduce((sum, row) => sum + row.durationMs, 0) / Math.max(results.length, 1)),
    p95DurationMs: percentile(results.map((row) => row.durationMs), 0.95),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    summary,
    failures: results.filter((row) => !row.hit),
    results,
  };

  const reportPath = `/tmp/e2e-benchmark-${runId}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("");
  console.log("Summary");
  console.log("═══════");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report: ${reportPath}`);
}

function parseOptionalPositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function runAgentQuery(message: string): Promise<string> {
  const parsed = await runAgentCommand(message);
  return String(parsed?.result?.payloads?.[0]?.text ?? "").trim();
}

async function resetAgentSession(reason: "new" | "reset"): Promise<void> {
  await execFileAsync(
    OPENCLAW_BIN,
    [
      "gateway",
      "call",
      "sessions.reset",
      "--json",
      "--timeout",
      "20000",
      "--params",
      JSON.stringify({ key: SESSION_KEY, reason }),
    ],
    { cwd: `${process.env.HOME}/.openclaw`, maxBuffer: 2 * 1024 * 1024 },
  );
}

async function runAgentCommand(message: string): Promise<any> {
  const { stdout } = await execFileAsync(
    OPENCLAW_BIN,
    ["agent", "--agent", AGENT_ID, "--message", message, "--timeout", "45", "--json"],
    { cwd: `${process.env.HOME}/.openclaw`, maxBuffer: 4 * 1024 * 1024 },
  );
  const payload = extractTrailingJson(stdout);
  return JSON.parse(payload);
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
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
