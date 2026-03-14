import { execFile } from "node:child_process";
import { access, cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { includesExpected } from "./layered-benchmark.js";
import { TURNING_ZERO_E2E_CASES } from "./turning-zero-e2e-fixtures.js";

const execFileAsync = promisify(execFile);

const OPENCLAW_CONFIG_PATH = "~/.openclaw/openclaw.json";
const OFFICIAL_PLUGIN_SOURCE = "~/Project/github/mem0ai/mem0/openclaw";
const OFFICIAL_PLUGIN_DIR = "~/.openclaw/extensions/openclaw-mem0";

type PluginVariant = {
  id: "memory-mem0" | "openclaw-mem0";
  label: string;
};

type AgentRow = {
  id: string;
  query: string;
  expected: string;
  answer: string;
  hit: boolean;
  durationMs: number;
};

type AgentSummary = {
  cases: number;
  hits: number;
  hitRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
};

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const originalConfig = await readFile(OPENCLAW_CONFIG_PATH, "utf-8");
  await ensureOfficialPluginDir();

  try {
    const current = await runVariant(
      { id: "memory-mem0", label: "Current plugin (memory-mem0)" },
      originalConfig,
    );
    const official = await runVariant(
      { id: "openclaw-mem0", label: "Official mem0 plugin (@mem0/openclaw-mem0)" },
      originalConfig,
    );

    const report = {
      generatedAt: new Date().toISOString(),
      method: "Real openclaw agent end-to-end benchmark on turning_zero. Each plugin variant runs all 40 cases in the same session; /new is issued only once when switching plugin variants. Auto-capture is disabled during the benchmark to keep the memory corpus frozen while switching only the memory plugin.",
      current,
      official,
      currentOnlyHits: current.rows.filter((row) => row.hit && !official.rows.find((r) => r.id === row.id)?.hit),
      officialOnlyHits: official.rows.filter((row) => row.hit && !current.rows.find((r) => r.id === row.id)?.hit),
      bothMisses: current.rows.filter((row) => !row.hit && !official.rows.find((r) => r.id === row.id)?.hit),
    };

    const jsonPath = `~/.openclaw/extensions/memory-mem0/reports/agent-plugin-e2e-comparison-${runId}.json`;
    const mdPath = `~/.openclaw/extensions/memory-mem0/reports/agent-plugin-e2e-comparison-${runId}.md`;
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");
    await writeFile(mdPath, renderMarkdown(report, jsonPath), "utf-8");

    console.log(JSON.stringify({ jsonPath, mdPath, current: current.summary, official: official.summary }, null, 2));
  } finally {
    await restoreConfig(originalConfig);
  }
}

async function ensureOfficialPluginDir(): Promise<void> {
  const manifestPath = `${OFFICIAL_PLUGIN_DIR}/openclaw.plugin.json`;
  try {
    const stat = await lstat(OFFICIAL_PLUGIN_DIR);
    if (stat.isDirectory()) {
      try {
        await access(manifestPath);
        return;
      } catch {
        await rm(OFFICIAL_PLUGIN_DIR, { recursive: true, force: true });
      }
    }
    else {
      await rm(OFFICIAL_PLUGIN_DIR, { recursive: true, force: true });
    }
  } catch (err) {
    const message = String(err);
    if (!message.includes("ENOENT")) throw err;
  }
  await cp(OFFICIAL_PLUGIN_SOURCE, OFFICIAL_PLUGIN_DIR, {
    recursive: true,
    force: true,
  });
}

async function runVariant(variant: PluginVariant, originalConfigText: string) {
  const config = JSON.parse(originalConfigText);
  const currentEntry = config?.plugins?.entries?.["memory-mem0"] ?? {};
  const currentPluginConfig = currentEntry?.config ?? {};
  const mem0Config = currentPluginConfig?.mem0 ?? {};
  const baseUserId = currentPluginConfig?.scope?.userId ?? "example_user";

  config.plugins = config.plugins ?? {};
  config.plugins.allow = Array.from(new Set([...(config.plugins.allow ?? []), "memory-mem0", "openclaw-mem0"]));
  config.plugins.entries = config.plugins.entries ?? {};

  config.plugins.entries["memory-mem0"] = {
    ...(config.plugins.entries["memory-mem0"] ?? {}),
    enabled: variant.id === "memory-mem0",
    config: {
      ...currentPluginConfig,
      capture: {
        ...(currentPluginConfig.capture ?? {}),
        enabled: false,
      },
    },
  };

  config.plugins.entries["openclaw-mem0"] = {
    enabled: variant.id === "openclaw-mem0",
    config: {
      mode: mem0Config.mode ?? "open-source",
      userId: baseUserId,
      autoRecall: true,
      autoCapture: false,
      searchThreshold: mem0Config.searchThreshold ?? 0.3,
      topK: mem0Config.topK ?? currentPluginConfig?.recall?.topK ?? 5,
      customPrompt: mem0Config.customPrompt,
      customInstructions: mem0Config.customPrompt,
      enableGraph: false,
      oss: mem0Config.oss ?? {},
    },
  };

  config.plugins.slots = config.plugins.slots ?? {};
  config.plugins.slots.memory = variant.id;

  await writeFile(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  await restartGateway();
  await resetAgentSession();

  const rows: AgentRow[] = [];
  for (const [index, item] of TURNING_ZERO_E2E_CASES.entries()) {
    const message = `请只用一句中文回答：${item.query}`;
    const started = Date.now();
    const answer = await runAgentQuery(message);
    const durationMs = Date.now() - started;
    const hit = includesExpected(answer, item.expected);
    rows.push({
      id: item.id,
      query: item.query,
      expected: item.expected,
      answer,
      hit,
      durationMs,
    });
    console.log(`[${variant.id}] [${index + 1}/${TURNING_ZERO_E2E_CASES.length}] ${item.id} hit=${hit ? "Y" : "N"} ${durationMs}ms`);
  }

  return {
    pluginId: variant.id,
    label: variant.label,
    summary: summarize(rows),
    rows,
    failures: rows.filter((row) => !row.hit),
  };
}

async function restoreConfig(originalConfigText: string): Promise<void> {
  await writeFile(OPENCLAW_CONFIG_PATH, originalConfigText, "utf-8");
  await restartGateway();
}

async function restartGateway(): Promise<void> {
  await execFileAsync("openclaw", ["gateway", "restart"], {
    cwd: "~/.openclaw",
    maxBuffer: 4 * 1024 * 1024,
  });
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
    { cwd: "~/.openclaw", maxBuffer: 4 * 1024 * 1024 },
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

function summarize(rows: AgentRow[]): AgentSummary {
  const hits = rows.filter((row) => row.hit).length;
  return {
    cases: rows.length,
    hits,
    hitRate: Number((hits / Math.max(rows.length, 1)).toFixed(3)),
    avgDurationMs: Math.round(rows.reduce((sum, row) => sum + row.durationMs, 0) / Math.max(rows.length, 1)),
    p95DurationMs: percentile(rows.map((row) => row.durationMs), 0.95),
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function renderMarkdown(
  report: {
    generatedAt: string;
    method: string;
    current: { pluginId: string; label: string; summary: AgentSummary; failures: AgentRow[] };
    official: { pluginId: string; label: string; summary: AgentSummary; failures: AgentRow[] };
    currentOnlyHits: AgentRow[];
    officialOnlyHits: AgentRow[];
    bothMisses: AgentRow[];
  },
  jsonPath: string,
): string {
  const lines: string[] = [
    "# Agent End-to-End Memory Plugin Comparison",
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Method: ${report.method}`,
    `- Raw report: [agent-plugin-e2e-comparison](${jsonPath})`,
    "",
    "## Summary",
    "",
    "| Metric | current plugin | official mem0 plugin |",
    "|---|---:|---:|",
    `| Hits (40 cases) | ${report.current.summary.hits}/${report.current.summary.cases} | ${report.official.summary.hits}/${report.official.summary.cases} |`,
    `| Hit rate | ${formatPct(report.current.summary.hitRate)} | ${formatPct(report.official.summary.hitRate)} |`,
    `| Avg duration | ${report.current.summary.avgDurationMs} ms | ${report.official.summary.avgDurationMs} ms |`,
    `| P95 duration | ${report.current.summary.p95DurationMs} ms | ${report.official.summary.p95DurationMs} ms |`,
    "",
    "## Current Plugin Only Hits",
    "",
    ...(report.currentOnlyHits.length > 0
      ? report.currentOnlyHits.map((row) => `- \`${row.id}\` ${row.query} -> expected \`${row.expected}\`, answer \`${row.answer}\``)
      : ["- None"]),
    "",
    "## Official Plugin Only Hits",
    "",
    ...(report.officialOnlyHits.length > 0
      ? report.officialOnlyHits.map((row) => `- \`${row.id}\` ${row.query} -> expected \`${row.expected}\`, answer \`${row.answer}\``)
      : ["- None"]),
    "",
    "## Both Miss",
    "",
    ...(report.bothMisses.length > 0
      ? report.bothMisses.map((row) => `- \`${row.id}\` ${row.query} -> expected \`${row.expected}\`, current answer \`${row.answer}\``)
      : ["- None"]),
    "",
    "## Conclusion",
    "",
    report.current.summary.hitRate > report.official.summary.hitRate
      ? "在真实 turning_zero agent 场景下，当前 memory-mem0 插件的端到端回答命中率高于官方 mem0 插件。"
      : report.current.summary.hitRate < report.official.summary.hitRate
        ? "在真实 turning_zero agent 场景下，官方 mem0 插件的端到端回答命中率更高。"
        : "在真实 turning_zero agent 场景下，两套插件的端到端回答命中率相同。",
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
