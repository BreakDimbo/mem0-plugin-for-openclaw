import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import { loadConfig, type MemuMemoryRecord, type MemoryScope } from "../types.js";
import { Mem0FreeTextBackend } from "../backends/free-text/mem0.js";
import { buildFreeTextMetadata, inferFreeTextMemoryKind, rerankMemoryResults } from "../metadata.js";
import { CHINESE_BENCHMARK_CASES } from "./chinese-query-fixtures.js";

type Eval = {
  top1Hit: boolean;
  top5Hit: boolean;
  top?: string;
  durableCount: number;
};

type CaseRow = {
  id: string;
  query: string;
  expected: string;
  expectedKind: string;
  raw: Eval;
  reranked: Eval;
};

async function main() {
  const raw = JSON.parse(fs.readFileSync("~/.openclaw/openclaw.json", "utf-8"));
  const cfg = loadConfig(raw.plugins.entries["memory-memu"].config);
  const backend = new Mem0FreeTextBackend(cfg, console);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const scope: MemoryScope = {
    userId: `zh.rerank.benchmark.${runId}`,
    agentId: "benchmark_agent",
    sessionKey: `agent:benchmark_agent:${runId}`,
  };

  console.log(`Chinese rerank benchmark scope: user=${scope.userId}`);
  console.log(`Seeding ${CHINESE_BENCHMARK_CASES.length} Chinese durable facts and paired transient noise...`);

  for (const [index, item] of CHINESE_BENCHMARK_CASES.entries()) {
    const durableOk = await storeWithRetry(
      backend,
      item.fact,
      scope,
      buildFreeTextMetadata(item.fact, scope, {
        captureKind: "explicit",
        extra: { benchmark_case: item.id, benchmark_role: "durable" },
      }),
      `${item.id}:durable`,
    );
    const transientText = `今天调试时顺手记一下：先不要把“${item.query}”这条临时提示长期保留。`;
    const transientOk = await storeWithRetry(
      backend,
      transientText,
      scope,
      buildFreeTextMetadata(transientText, scope, {
        captureKind: "auto",
        extra: { benchmark_case: item.id, benchmark_role: "transient-noise" },
      }),
      `${item.id}:transient`,
    );
    if (!durableOk || !transientOk) {
      throw new Error(`Failed seeding ${item.id}: durable=${durableOk} transient=${transientOk}`);
    }
    if ((index + 1) % 5 === 0 || index === CHINESE_BENCHMARK_CASES.length - 1) {
      console.log(`  Seeded ${index + 1}/${CHINESE_BENCHMARK_CASES.length}`);
    }
  }

  const rows: CaseRow[] = [];
  for (const [index, item] of CHINESE_BENCHMARK_CASES.entries()) {
    const rawHits = await withTimeout(
      backend.search(item.query, scope, {
        maxItems: 8,
        maxContextChars: cfg.recall.maxContextChars,
        includeSessionScope: true,
      }),
      20_000,
      `search timeout for ${item.id}`,
    );
    const rerankedHits = rerankMemoryResults(item.query, rawHits).slice(0, 5);
    rows.push({
      id: item.id,
      query: item.query,
      expected: item.expected,
      expectedKind: inferFreeTextMemoryKind(item.fact),
      raw: evaluate(rawHits, item.expected),
      reranked: evaluate(rerankedHits, item.expected),
    });
    if ((index + 1) % 5 === 0 || index === CHINESE_BENCHMARK_CASES.length - 1) {
      console.log(`  Evaluated ${index + 1}/${CHINESE_BENCHMARK_CASES.length}`);
    }
  }

  const summary = {
    raw: summarize(rows.map((row) => row.raw)),
    reranked: summarize(rows.map((row) => row.reranked)),
    cases: rows.length,
    improvedTop1: rows.filter((row) => !row.raw.top1Hit && row.reranked.top1Hit).length,
    improvedTop5: rows.filter((row) => !row.raw.top5Hit && row.reranked.top5Hit).length,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    scope,
    summary,
    rows,
  };
  const reportPath = `/tmp/memory-memu-chinese-rerank-benchmark-${runId}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("");
  console.log("Chinese Rerank Benchmark");
  console.log("════════════════════════");
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log(`Detailed report: ${reportPath}`);
}

function evaluate(items: MemuMemoryRecord[], expected: string): Eval {
  const normalized = expected.trim().toLowerCase();
  const top = items[0]?.text;
  return {
    top,
    top1Hit: Boolean(top && top.toLowerCase().includes(normalized)),
    top5Hit: items.slice(0, 5).some((item) => item.text.toLowerCase().includes(normalized)),
    durableCount: items.filter((item) => item.metadata?.quality === "durable").length,
  };
}

function summarize(rows: Eval[]) {
  return {
    top1Hits: rows.filter((row) => row.top1Hit).length,
    top5Hits: rows.filter((row) => row.top5Hit).length,
    top1Rate: Number((rows.filter((row) => row.top1Hit).length / rows.length).toFixed(3)),
    top5Rate: Number((rows.filter((row) => row.top5Hit).length / rows.length).toFixed(3)),
    durableHits: rows.reduce((sum, row) => sum + row.durableCount, 0),
  };
}

async function storeWithRetry(
  backend: { store(text: string, scope: MemoryScope, options?: { metadata?: Record<string, unknown> }): Promise<boolean>; provider: string },
  text: string,
  scope: MemoryScope,
  metadata: Record<string, unknown>,
  label: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ok = await withTimeout(
      backend.store(text, scope, { metadata }),
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
