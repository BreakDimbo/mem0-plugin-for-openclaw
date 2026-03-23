import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { LRUCache } from "../cache.js";
import { CoreMemoryRepository } from "../core-repository.js";
import { createRecallHook } from "../hooks/recall.js";
import { buildDynamicScope, loadConfig, type MemuMemoryRecord } from "../types.js";
import { createPrimaryFreeTextBackend } from "../backends/free-text/factory.js";
import { includesExpected, summarizeLayeredRows, type LayeredBenchmarkRow } from "./layered-benchmark.js";
import { BENCHMARK_E2E_CASES } from "./benchmark-e2e-fixtures.js";

const execFileAsync = promisify(execFile);

async function main() {
  const limit = parseOptionalPositiveInt(process.env.E2E_LIMIT);
  const resetPerCase = process.env.BENCHMARK_RESET_SESSION !== "0";
  const cases = limit ? BENCHMARK_E2E_CASES.slice(0, limit) : BENCHMARK_E2E_CASES;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const config = await loadPluginConfig();
  const hook = await buildRecallHook(config);
  const rows: LayeredBenchmarkRow[] = [];

  console.log(`Running ${cases.length} layered benchmark cases...`);
  for (const [index, item] of cases.entries()) {
    if (resetPerCase) {
      await resetAgentSession();
    }
    const injectedContext = await renderInjectedContext(hook, item.query);
    const started = Date.now();
    const answer = await runAgentQuery(`请只用一句中文回答：${item.query}`);
    const durationMs = Date.now() - started;
    const injectionHit = includesExpected(injectedContext, item.expected);
    const answerHit = includesExpected(answer, item.expected);
    rows.push({
      id: item.id,
      query: item.query,
      expected: item.expected,
      injectedContext,
      injectionHit,
      answer,
      answerHit,
      durationMs,
    });
    console.log(`[${index + 1}/${cases.length}] ${item.id} injection=${injectionHit ? "Y" : "N"} answer=${answerHit ? "Y" : "N"} ${durationMs}ms`);
  }

  const summary = summarizeLayeredRows(cases, rows);
  const report = {
    generatedAt: new Date().toISOString(),
    summary,
    injectionOnlyCases: rows.filter((row) => row.injectionHit && !row.answerHit),
    answerWithoutInjectionCases: rows.filter((row) => !row.injectionHit && row.answerHit),
    missedBothCases: rows.filter((row) => !row.injectionHit && !row.answerHit),
    rows,
  };

  const reportPath = `/tmp/layered-benchmark-${runId}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("");
  console.log("Summary");
  console.log("═══════");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report: ${reportPath}`);
}

async function loadPluginConfig() {
  const raw = JSON.parse(await readFile(`${process.env.HOME}/.openclaw/openclaw.json`, "utf-8"));
  return loadConfig(raw?.plugins?.entries?.["memory-mem0"]?.config ?? {});
}

async function buildRecallHook(config: ReturnType<typeof loadConfig>) {
  const logger = { info: (_msg: string) => {}, warn: (_msg: string) => {} };
  const scopeResolver = {
    resolveRuntimeScope: (ctx?: { agentId?: string; sessionKey?: string; sessionId?: string; workspaceDir?: string }) =>
      buildDynamicScope(config.scope, ctx),
  };
  const primary = createPrimaryFreeTextBackend(config, { logger });
  const coreRepo = new CoreMemoryRepository(config.core.persistPath, logger, config.core.maxItemChars);
  const cache = new LRUCache<MemuMemoryRecord[]>(config.recall.cacheMaxSize, config.recall.cacheTtlMs);
  const inbound = { getBySender: async () => "" };
  const metrics = {
    recallTotal: 0,
    recallHits: 0,
    recallMisses: 0,
    recallErrors: 0,
    recordRecallLatency: () => {},
    recordRecallCompare: () => {},
    recordRecallFallback: () => {},
  };
  const sync = { registerAgent: () => {} };
  return createRecallHook(primary, scopeResolver, coreRepo, cache, inbound as any, config, logger, metrics as any, sync as any);
}

async function renderInjectedContext(
  hook: ReturnType<typeof createRecallHook>,
  query: string,
): Promise<string> {
  const result = await hook(
    {
      prompt: `请只用一句中文回答：${query}`,
      messages: [{ role: "user", content: query }],
    },
    {
      agentId: "turning_zero",
      workspaceDir: `${process.env.HOME}/.openclaw/workspace-turning_zero`,
    } as any,
  );
  return String((result as { prependContext?: string } | undefined)?.prependContext ?? "");
}

async function runAgentQuery(message: string): Promise<string> {
  const parsed = await runAgentCommand(message);
  return String(parsed?.result?.payloads?.[0]?.text ?? "").trim();
}

async function resetAgentSession(): Promise<void> {
  await runAgentCommand("/new");
}

async function runAgentCommand(message: string): Promise<any> {
  const { stdout } = await execFileAsync(
    "openclaw",
    ["agent", "--agent", "turning_zero", "--message", message, "--timeout", "45", "--json"],
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

function parseOptionalPositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
