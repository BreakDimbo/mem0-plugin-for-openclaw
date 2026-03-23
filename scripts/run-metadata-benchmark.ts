import { writeFile } from "node:fs/promises";
import fs from "node:fs";
import { loadConfig, type MemoryScope } from "../types.js";
import { Mem0FreeTextBackend } from "../backends/free-text/mem0.js";
import { benchmarkSearchProfiles, formatSearchBenchmarkReport, summarizeSearchBenchmark, type SearchBenchmarkCase } from "../backends/free-text/benchmark.js";
import { BENCHMARK_CASES } from "./benchmark-fixtures.js";
import { buildFreeTextMetadata, inferFreeTextMemoryKind } from "../metadata.js";

function noiseTextForCase(testCase: SearchBenchmarkCase): string {
  return `Temporary test note for today only: while checking "${testCase.query}", do not persist this transient reminder after the benchmark.`;
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, "utf-8"));
  const cfg = loadConfig(raw.plugins.entries["memory-mem0"].config);
  const logger = console;
  const backend = new Mem0FreeTextBackend(cfg, logger);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const scope: MemoryScope = {
    userId: `metadata.benchmark.user.${runId}`,
    agentId: "benchmark_agent",
    sessionKey: `agent:benchmark_agent:${runId}`,
  };

  const cases: SearchBenchmarkCase[] = BENCHMARK_CASES.map((item) => ({
    id: item.id,
    query: item.query,
    expected: item.expected,
    expectedKind: inferFreeTextMemoryKind(item.fact),
  }));

  console.log(`Metadata benchmark scope: user=${scope.userId} agent=${scope.agentId}`);
  console.log(`Seeding ${BENCHMARK_CASES.length} durable facts and ${BENCHMARK_CASES.length} transient noise items into mem0...`);

  for (const testCase of BENCHMARK_CASES) {
    const durableOk = await storeWithRetry(
      backend,
      testCase.fact,
      scope,
      buildFreeTextMetadata(testCase.fact, scope, {
        captureKind: "explicit",
        extra: {
          benchmark_case: testCase.id,
          benchmark_role: "durable",
        },
      }),
      `${testCase.id}:durable`,
    );
    const transientText = noiseTextForCase(testCase);
    const transientOk = await storeWithRetry(
      backend,
      transientText,
      scope,
      buildFreeTextMetadata(transientText, scope, {
        captureKind: "auto",
        extra: {
          benchmark_case: testCase.id,
          benchmark_role: "transient-noise",
        },
      }),
      `${testCase.id}:transient`,
    );
    if (!durableOk || !transientOk) {
      throw new Error(`Failed seeding case ${testCase.id}: durable=${durableOk} transient=${transientOk}`);
    }
    if (Number(testCase.id) % 10 === 0 || testCase.id === BENCHMARK_CASES.at(-1)?.id) {
      console.log(`  Seeded ${testCase.id}/${BENCHMARK_CASES.length}`);
    }
  }

  const profiles = [
    { name: "baseline", options: {} },
    { name: "durable_only", options: { quality: "durable" as const } },
    { name: "durable_plus_kind", options: undefined },
  ];

  const rows = await benchmarkSearchProfiles(
    backend,
    scope,
    cases,
    profiles.map((profile) => profile.name === "durable_plus_kind"
      ? {
          name: profile.name,
          options: undefined,
        }
      : profile),
    {
      maxItems: 5,
      maxContextChars: cfg.recall.maxChars,
    },
  );

  console.log(`  Evaluated ${rows.length}/${cases.length} cases`);

  for (const row of rows) {
    const durablePlusKind = row.profiles.find((item) => item.name === "durable_plus_kind");
    if (!durablePlusKind) continue;
    const rerun = await backend.search(row.query, scope, {
      maxItems: 5,
      maxContextChars: cfg.recall.maxChars,
      quality: "durable",
      memoryKinds: row.expectedKind ? [row.expectedKind] : undefined,
      includeSessionScope: true,
    });
    durablePlusKind.count = rerun.length;
    durablePlusKind.top = rerun[0]?.text;
    durablePlusKind.top1Hit = row.expected ? Boolean(rerun[0]?.text?.toLowerCase().includes(row.expected.toLowerCase())) : undefined;
    durablePlusKind.top5Hit = row.expected ? rerun.some((item) => item.text.toLowerCase().includes(row.expected!.toLowerCase())) : undefined;
    durablePlusKind.durableCount = rerun.filter((item) => item.metadata?.quality === "durable").length;
    durablePlusKind.transientCount = rerun.filter((item) => item.metadata?.quality === "transient").length;
    durablePlusKind.expectedKindHits = row.expectedKind ? rerun.filter((item) => item.metadata?.memory_kind === row.expectedKind).length : 0;
  }

  const summary = summarizeSearchBenchmark(rows);
  const report = {
    generatedAt: new Date().toISOString(),
    scope,
    summary,
    rows,
  };
  const reportPath = `/tmp/memory-memu-metadata-benchmark-${runId}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("");
  console.log(formatSearchBenchmarkReport(rows));
  console.log("");
  console.log(`Detailed report: ${reportPath}`);
}

async function storeWithRetry(
  backend: { store(messages: Array<{ role: "user" | "assistant"; content: string }>, scope: MemoryScope, options?: { metadata?: Record<string, unknown> }): Promise<boolean>; provider: string },
  text: string,
  scope: MemoryScope,
  metadata: Record<string, unknown>,
  label: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ok = await withTimeout(
      backend.store([{ role: "user", content: text }], scope, { metadata }),
      25_000,
      `${backend.provider} store timeout for ${label} attempt ${attempt}`,
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
