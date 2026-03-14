import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import { loadConfig, type MemoryScope } from "../types.js";
import { MemUClient } from "../client.js";
import { MemUAdapter } from "../adapter.js";
import { Mem0FreeTextBackend } from "../backends/free-text/mem0.js";
import { MemUFreeTextBackend } from "../backends/free-text/memu.js";
import { BENCHMARK_CASES } from "./benchmark-fixtures.js";

type BackendEval = {
  top1Hit: boolean;
  top5Hit: boolean;
  top1?: string;
  top5: string[];
};

type CaseResult = {
  id: string;
  query: string;
  expected: string;
  mem0: BackendEval;
  memu: BackendEval;
};

const CASES = BENCHMARK_CASES;

async function main() {
  const raw = JSON.parse(fs.readFileSync("~/.openclaw/openclaw.json", "utf-8"));
  const cfg = loadConfig(raw.plugins.entries["memory-memu"].config);
  const logger = console;
  const client = new MemUClient(cfg.memu.baseUrl, cfg.memu.timeoutMs, cfg.memu.healthCheckPath, logger);
  const adapter = new MemUAdapter(client, cfg, logger);
  const mem0 = new Mem0FreeTextBackend(cfg, logger);
  const memu = new MemUFreeTextBackend(adapter, () => client.healthCheck());

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const scope: MemoryScope = {
    userId: `benchmark.user.${runId}`,
    agentId: "benchmark_agent",
    sessionKey: `agent:benchmark_agent:${runId}`,
  };

  console.log(`Benchmark scope: user=${scope.userId} agent=${scope.agentId} session=${scope.sessionKey}`);
  console.log(`Seeding ${CASES.length} facts into mem0 and memu...`);

  for (const [index, item] of CASES.entries()) {
    const [okMem0, okMemu] = await Promise.all([
      storeWithRetry(mem0, item.fact, scope, item.id),
      storeWithRetry(memu, item.fact, scope, item.id),
    ]);
    if (!okMem0 || !okMemu) {
      throw new Error(`Failed to seed benchmark case ${item.id}: mem0=${okMem0} memu=${okMemu}`);
    }
    if ((index + 1) % 10 === 0 || index === CASES.length - 1) {
      console.log(`  Seeded ${index + 1}/${CASES.length}`);
    }
  }

  const results: CaseResult[] = [];
  console.log(`Running ${CASES.length} retrieval checks...`);
  for (const [index, item] of CASES.entries()) {
    const [mem0Results, memuResults] = await Promise.all([
      withTimeout(
        mem0.search(item.query, scope, { maxItems: 5, includeSessionScope: true }),
        20_000,
        `mem0 search timeout for case ${item.id}`,
      ),
      withTimeout(
        memu.search(item.query, scope, { maxItems: 5 }),
        20_000,
        `memu search timeout for case ${item.id}`,
      ),
    ]);
    results.push({
      id: item.id,
      query: item.query,
      expected: item.expected,
      mem0: evaluate(mem0Results, item.expected),
      memu: evaluate(memuResults, item.expected),
    });
    if ((index + 1) % 10 === 0 || index === CASES.length - 1) {
      console.log(`  Evaluated ${index + 1}/${CASES.length}`);
    }
  }

  const summary = {
    cases: results.length,
    mem0: summarize(results.map((item) => item.mem0)),
    memu: summarize(results.map((item) => item.memu)),
    scope,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    summary,
    failures: {
      mem0Top1Misses: results.filter((item) => !item.mem0.top1Hit).slice(0, 10),
      memuTop1Misses: results.filter((item) => !item.memu.top1Hit).slice(0, 10),
      mem0Top5Misses: results.filter((item) => !item.mem0.top5Hit).slice(0, 10),
      memuTop5Misses: results.filter((item) => !item.memu.top5Hit).slice(0, 10),
    },
  };

  const reportPath = `/tmp/memory-memu-benchmark-${runId}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("");
  console.log("Summary");
  console.log("═══════");
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log(`Detailed report: ${reportPath}`);
}

function evaluate(results: Array<{ text: string }>, expected: string): BackendEval {
  const normalizedExpected = expected.trim().toLowerCase();
  const top5 = results.map((item) => item.text);
  const top1 = top5[0];
  return {
    top1,
    top5,
    top1Hit: Boolean(top1 && top1.toLowerCase().includes(normalizedExpected)),
    top5Hit: top5.some((item) => item.toLowerCase().includes(normalizedExpected)),
  };
}

function summarize(rows: BackendEval[]) {
  return {
    top1Hits: rows.filter((row) => row.top1Hit).length,
    top5Hits: rows.filter((row) => row.top5Hit).length,
    top1Rate: Number((rows.filter((row) => row.top1Hit).length / rows.length).toFixed(3)),
    top5Rate: Number((rows.filter((row) => row.top5Hit).length / rows.length).toFixed(3)),
  };
}

async function storeWithRetry(
  backend: { store(text: string, scope: MemoryScope, options?: { metadata?: Record<string, unknown> }): Promise<boolean>; provider: string },
  text: string,
  scope: MemoryScope,
  caseId: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ok = await withTimeout(
      backend.store(text, scope, {
        metadata: { capture_kind: "explicit", benchmark_case: caseId, benchmark_attempt: attempt },
      }),
      25_000,
      `${backend.provider} store timeout for case ${caseId} attempt ${attempt}`,
    );
    if (ok) return true;
    await sleep(250 * attempt);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
