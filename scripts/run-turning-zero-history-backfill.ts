import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import { loadConfig, type MemoryScope } from "../types.js";
import { buildFreeTextMetadata, rerankMemoryResults } from "../metadata.js";
import { Mem0FreeTextBackend } from "../backends/free-text/mem0.js";
import { BENCHMARK_HISTORY_FACTS, BENCHMARK_RECALL_CASES } from "./benchmark-history-fixtures.js";

type RecallCaseReport = {
  id: string;
  query: string;
  expected: string;
  top1?: string;
  top1Hit: boolean;
  top5Hit: boolean;
  hits: string[];
};

async function main() {
  const raw = JSON.parse(fs.readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, "utf-8"));
  const cfg = loadConfig(raw.plugins.entries["memory-mem0"].config);
  const logger = console;
  const backend = new Mem0FreeTextBackend(cfg, logger);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const batchId = `benchmark-history-${runId}`;
  const agentId = process.env.BENCHMARK_AGENT_ID || "main";
  const scope: MemoryScope = {
    userId: cfg.scope.userIdByAgent?.[agentId] ?? cfg.scope.userId,
    agentId,
    sessionKey: `agent:${agentId}:main`,
  };

  console.log(`Backfill scope: user=${scope.userId} agent=${scope.agentId} session=${scope.sessionKey}`);
  console.log(`Seeding ${BENCHMARK_HISTORY_FACTS.length} durable facts into mem0...`);

  const seedResults = [];
  for (const [index, fact] of BENCHMARK_HISTORY_FACTS.entries()) {
    const metadata = buildFreeTextMetadata(fact.text, scope, {
      captureKind: "explicit",
      extra: {
        memory_kind: fact.memoryKind,
        quality: "durable",
        source_session: fact.sourceLabel,
        source_label: fact.sourceLabel,
        backfill: true,
        backfill_batch: batchId,
      },
    });
    const ok = await withTimeout(
      backend.store([{ role: "user", content: fact.text }], scope, { metadata }),
      60_000,
      `store timeout for ${fact.id}`,
    );
    seedResults.push({ id: fact.id, ok });
    if (!ok) {
      throw new Error(`Failed to store fact ${fact.id}: ${fact.text}`);
    }
    if ((index + 1) % 10 === 0 || index === BENCHMARK_HISTORY_FACTS.length - 1) {
      console.log(`  Seeded ${index + 1}/${BENCHMARK_HISTORY_FACTS.length}`);
    }
  }

  console.log(`Running ${BENCHMARK_RECALL_CASES.length} backend recall checks...`);
  const recallReports: RecallCaseReport[] = [];
  for (const item of BENCHMARK_RECALL_CASES) {
    const hits = await withTimeout(
      backend.search(item.query, scope, {
        maxItems: 5,
        includeSessionScope: true,
        quality: "durable",
        memoryKinds: item.memoryKinds,
      }),
      20_000,
      `search timeout for ${item.id}`,
    );
    const reranked = rerankMemoryResults(item.query, hits, { preferDurable: true }).slice(0, 5);
    const top1 = reranked[0]?.text;
    const normalizedExpected = item.expected.toLowerCase();
    recallReports.push({
      id: item.id,
      query: item.query,
      expected: item.expected,
      top1,
      top1Hit: Boolean(top1 && top1.toLowerCase().includes(normalizedExpected)),
      top5Hit: reranked.some((hit) => hit.text.toLowerCase().includes(normalizedExpected)),
      hits: reranked.map((hit) => hit.text),
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    batchId,
    scope,
    seeded: {
      attempted: BENCHMARK_HISTORY_FACTS.length,
      succeeded: seedResults.filter((item) => item.ok).length,
      failed: seedResults.filter((item) => !item.ok).length,
    },
    recall: {
      cases: recallReports.length,
      top1Hits: recallReports.filter((item) => item.top1Hit).length,
      top5Hits: recallReports.filter((item) => item.top5Hit).length,
    },
    facts: BENCHMARK_HISTORY_FACTS,
    recallReports,
  };

  const reportPath = `/tmp/benchmark-history-backfill-${runId}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("");
  console.log("Summary");
  console.log("═══════");
  console.log(JSON.stringify(report.seeded, null, 2));
  console.log(JSON.stringify(report.recall, null, 2));
  console.log(`Report: ${reportPath}`);
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
