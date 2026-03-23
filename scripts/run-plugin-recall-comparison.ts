import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { LRUCache } from "../cache.js";
import { CoreMemoryRepository } from "../core-repository.js";
import { createRecallHook } from "../hooks/recall.js";
import { loadConfig, buildDynamicScope, type MemuMemoryRecord } from "../types.js";
import { createPrimaryFreeTextBackend } from "../backends/free-text/factory.js";
import { includesExpected } from "./layered-benchmark.js";
import { BENCHMARK_E2E_CASES } from "./benchmark-e2e-fixtures.js";

type CompareRow = {
  id: string;
  query: string;
  expected: string;
  currentHit: boolean;
  officialHit: boolean;
  currentDurationMs: number;
  officialDurationMs: number;
  currentChars: number;
  officialChars: number;
  currentContext: string;
  officialContext: string;
};

type CompareSummary = {
  total: number;
  currentHits: number;
  currentHitRate: number;
  officialHits: number;
  officialHitRate: number;
  currentAvgDurationMs: number;
  officialAvgDurationMs: number;
  currentAvgChars: number;
  officialAvgChars: number;
  currentOnlyHits: number;
  officialOnlyHits: number;
  bothHits: number;
  bothMisses: number;
};

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const raw = JSON.parse(await readFile(`${process.env.HOME}/.openclaw/openclaw.json`, "utf-8"));
  const currentConfig = loadConfig(raw?.plugins?.entries?.["memory-mem0"]?.config ?? {});
  const currentHook = await buildCurrentRecallHook(currentConfig);
  const officialHook = await buildOfficialRecallHook(raw, currentConfig);

  const rows: CompareRow[] = [];
  for (const item of BENCHMARK_E2E_CASES) {
    const prompt = `请只用一句中文回答：${item.query}`;
    const sessionKey = `agent:main:compare-${item.id}`;
    const sessionId = `compare-${item.id}`;

    const currentStarted = Date.now();
    const currentContext = await renderCurrentContext(currentHook, item.query, sessionKey, sessionId);
    const currentDurationMs = Date.now() - currentStarted;

    const officialStarted = Date.now();
    const officialContext = await renderOfficialContext(officialHook, prompt, sessionKey);
    const officialDurationMs = Date.now() - officialStarted;

    rows.push({
      id: item.id,
      query: item.query,
      expected: item.expected,
      currentHit: includesExpected(currentContext, item.expected),
      officialHit: includesExpected(officialContext, item.expected),
      currentDurationMs,
      officialDurationMs,
      currentChars: currentContext.length,
      officialChars: officialContext.length,
      currentContext,
      officialContext,
    });
  }

  const summary = summarize(rows);
  const report = {
    generatedAt: new Date().toISOString(),
    method: "Recall-layer comparison using injected context only; model answer variability excluded.",
    currentPlugin: "memory-mem0",
    baselinePlugin: "@mem0/openclaw-mem0",
    summary,
    currentOnlyCases: rows.filter((row) => row.currentHit && !row.officialHit),
    officialOnlyCases: rows.filter((row) => !row.currentHit && row.officialHit),
    bothMissCases: rows.filter((row) => !row.currentHit && !row.officialHit),
    rows,
  };

  const jsonPath = `${process.env.HOME}/.openclaw/extensions/memory-mem0/reports/plugin-recall-comparison-${runId}.json`;
  const mdPath = `${process.env.HOME}/.openclaw/extensions/memory-mem0/reports/plugin-recall-comparison-${runId}.md`;
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  await writeFile(mdPath, renderMarkdown(report, jsonPath), "utf-8");

  console.log(JSON.stringify({ summary, jsonPath, mdPath }, null, 2));
}

async function buildCurrentRecallHook(config: ReturnType<typeof loadConfig>) {
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

async function buildOfficialRecallHook(rawConfig: any, currentConfig: ReturnType<typeof loadConfig>) {
  const mod = await import(pathToFileURL(resolveOfficialPluginEntry()).href);
  const plugin = mod.default as { register(api: Record<string, unknown>): void };
  let beforeAgentStart:
    | ((event: { prompt?: string }, ctx: { sessionKey?: string }) => Promise<{ prependContext?: string } | void>)
    | undefined;

  const api = {
    pluginConfig: {
      mode: rawConfig?.plugins?.entries?.["memory-mem0"]?.config?.mem0?.mode ?? "open-source",
      userId: currentConfig.scope.userId,
      autoCapture: false,
      autoRecall: true,
      searchThreshold: rawConfig?.plugins?.entries?.["memory-mem0"]?.config?.mem0?.searchThreshold ?? 0.3,
      topK: currentConfig.recall.topK,
      enableGraph: false,
      oss: rawConfig?.plugins?.entries?.["memory-mem0"]?.config?.mem0?.oss ?? {},
    },
    logger: { info: (_msg: string) => {}, warn: (_msg: string) => {} },
    resolvePath: (p: string) =>
      p.startsWith("~/.openclaw/")
        ? p.replace(/^~\/\.openclaw\//, `${process.env.HOME}/.openclaw/`)
        : p,
    on: (event: string, handler: unknown) => {
      if (event === "before_agent_start") beforeAgentStart = handler as any;
    },
    registerTool: () => {},
    registerCli: () => {},
    registerService: () => {},
  };

  plugin.register(api as any);
  if (!beforeAgentStart) {
    throw new Error("Official mem0 plugin did not register before_agent_start hook");
  }
  return beforeAgentStart;
}

function resolveOfficialPluginEntry(): string {
  const configured = process.env.OFFICIAL_MEM0_PLUGIN_ENTRY;
  if (!configured) {
    throw new Error("Set OFFICIAL_MEM0_PLUGIN_ENTRY to the official mem0 plugin entry file before running this comparison");
  }
  if (configured.startsWith("~/")) {
    return `${process.env.HOME}${configured.slice(1)}`;
  }
  return resolve(configured);
}

async function renderCurrentContext(
  hook: ReturnType<typeof createRecallHook>,
  query: string,
  sessionKey: string,
  sessionId: string,
): Promise<string> {
  const result = await hook(
    {
      prompt: `请只用一句中文回答：${query}`,
      messages: [{ role: "user", content: query }],
    },
    {
      agentId: "main",
      sessionKey,
      sessionId,
      workspaceDir: `${process.env.HOME}/.openclaw/workspace-turning_zero`,
    } as any,
  );
  return String((result as { prependContext?: string } | undefined)?.prependContext ?? "");
}

async function renderOfficialContext(
  hook: (event: { prompt?: string }, ctx: { sessionKey?: string }) => Promise<{ prependContext?: string } | void>,
  prompt: string,
  sessionKey: string,
): Promise<string> {
  const result = await hook(
    { prompt },
    { sessionKey },
  );
  return String((result as { prependContext?: string } | undefined)?.prependContext ?? "");
}

function summarize(rows: CompareRow[]): CompareSummary {
  const total = rows.length;
  const currentHits = rows.filter((row) => row.currentHit).length;
  const officialHits = rows.filter((row) => row.officialHit).length;
  const currentOnlyHits = rows.filter((row) => row.currentHit && !row.officialHit).length;
  const officialOnlyHits = rows.filter((row) => !row.currentHit && row.officialHit).length;
  const bothHits = rows.filter((row) => row.currentHit && row.officialHit).length;
  const bothMisses = rows.filter((row) => !row.currentHit && !row.officialHit).length;
  const currentAvgDurationMs = Math.round(rows.reduce((sum, row) => sum + row.currentDurationMs, 0) / Math.max(total, 1));
  const officialAvgDurationMs = Math.round(rows.reduce((sum, row) => sum + row.officialDurationMs, 0) / Math.max(total, 1));
  const currentAvgChars = Math.round(rows.reduce((sum, row) => sum + row.currentChars, 0) / Math.max(total, 1));
  const officialAvgChars = Math.round(rows.reduce((sum, row) => sum + row.officialChars, 0) / Math.max(total, 1));

  return {
    total,
    currentHits,
    currentHitRate: Number((currentHits / Math.max(total, 1)).toFixed(3)),
    officialHits,
    officialHitRate: Number((officialHits / Math.max(total, 1)).toFixed(3)),
    currentAvgDurationMs,
    officialAvgDurationMs,
    currentAvgChars,
    officialAvgChars,
    currentOnlyHits,
    officialOnlyHits,
    bothHits,
    bothMisses,
  };
}

function renderMarkdown(report: { generatedAt: string; method: string; currentPlugin: string; baselinePlugin: string; summary: CompareSummary; currentOnlyCases: CompareRow[]; officialOnlyCases: CompareRow[]; bothMissCases: CompareRow[] }, jsonPath: string): string {
  const { summary } = report;
  const lines: string[] = [
    "# Memory Plugin Recall Comparison",
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Method: ${report.method}`,
    `- Current plugin: \`${report.currentPlugin}\``,
    `- Baseline plugin: \`${report.baselinePlugin}\``,
    `- Raw report: [plugin-recall-comparison](${jsonPath})`,
    "",
    "## Summary",
    "",
    "| Metric | memory-mem0 | official mem0 plugin |",
    "|---|---:|---:|",
    `| Recall hits (40 cases) | ${summary.currentHits}/${summary.total} | ${summary.officialHits}/${summary.total} |`,
    `| Recall hit rate | ${formatPct(summary.currentHitRate)} | ${formatPct(summary.officialHitRate)} |`,
    `| Avg recall time | ${summary.currentAvgDurationMs} ms | ${summary.officialAvgDurationMs} ms |`,
    `| Avg injected chars | ${summary.currentAvgChars} | ${summary.officialAvgChars} |`,
    "",
    "## Difference Breakdown",
    "",
    `- Current plugin only hits: ${summary.currentOnlyHits}`,
    `- Official plugin only hits: ${summary.officialOnlyHits}`,
    `- Both hit: ${summary.bothHits}`,
    `- Both miss: ${summary.bothMisses}`,
    "",
    "## Current Plugin Only Hits",
    "",
    ...(report.currentOnlyCases.length > 0
      ? report.currentOnlyCases.map((row) => `- \`${row.id}\` ${row.query} -> expected \`${row.expected}\``)
      : ["- None"]),
    "",
    "## Official Plugin Only Hits",
    "",
    ...(report.officialOnlyCases.length > 0
      ? report.officialOnlyCases.map((row) => `- \`${row.id}\` ${row.query} -> expected \`${row.expected}\``)
      : ["- None"]),
    "",
    "## Both Miss",
    "",
    ...(report.bothMissCases.length > 0
      ? report.bothMissCases.map((row) => `- \`${row.id}\` ${row.query} -> expected \`${row.expected}\``)
      : ["- None"]),
    "",
    "## Conclusion",
    "",
    summary.currentHitRate > summary.officialHitRate
      ? `在当前这 40 条测试集上，\`${report.currentPlugin}\` 的 recall 命中率高于官方 mem0 插件，主要优势来自本地 Core Memory、workspace fact 补洞和更细的 query-aware 选择。`
      : summary.currentHitRate < summary.officialHitRate
        ? `在当前这 40 条测试集上，官方 mem0 插件的 recall 命中率更高，说明当前自定义插件还有进一步简化或修正空间。`
        : `在当前这 40 条测试集上，两者 recall 命中率相同，差异主要体现在注入体积和策略设计上。`,
    "",
  ];

  return `${lines.join("\n")}\n`;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
