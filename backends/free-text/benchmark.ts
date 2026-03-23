import type { MemoryScope, MemuMemoryRecord } from "../../types.js";
import type { FreeTextBackend, FreeTextSearchOptions } from "./base.js";
import { compareMemorySets, type BackendCompareResult } from "./compare.js";

export type BackendBenchmarkRow = BackendCompareResult & {
  query: string;
  primaryTop?: string;
  shadowTop?: string;
};

export type SearchBenchmarkCase = {
  id: string;
  query: string;
  expected?: string;
  expectedKind?: string;
};

export type SearchBenchmarkProfile = {
  name: string;
  options?: FreeTextSearchOptions;
};

export type SearchBenchmarkRow = {
  id: string;
  query: string;
  expected?: string;
  expectedKind?: string;
  profiles: Array<{
    name: string;
    count: number;
    top?: string;
    top1Hit?: boolean;
    top5Hit?: boolean;
    durableCount: number;
    transientCount: number;
    expectedKindHits: number;
  }>;
};

export type SearchBenchmarkSummary = Array<{
  name: string;
  top1Hits: number;
  top5Hits: number;
  top1Rate?: number;
  top5Rate?: number;
  durableHits: number;
  transientHits: number;
  expectedKindHits: number;
}>;

export async function benchmarkBackends(
  primaryBackend: FreeTextBackend,
  shadowBackend: FreeTextBackend,
  scope: MemoryScope,
  queries: string[],
  options: { maxItems: number; maxContextChars?: number },
): Promise<BackendBenchmarkRow[]> {
  const rows: BackendBenchmarkRow[] = [];
  for (const query of queries.map((item) => item.trim()).filter(Boolean)) {
    const [primary, shadow] = await Promise.all([
      primaryBackend.search(query, scope, {
        maxItems: options.maxItems,
        maxContextChars: options.maxContextChars,
        includeSessionScope: primaryBackend.provider === "mem0",
      }),
      shadowBackend.search(query, scope, {
        maxItems: options.maxItems,
        maxContextChars: options.maxContextChars,
        includeSessionScope: shadowBackend.provider === "mem0",
      }),
    ]);
    const comparison = compareMemorySets(primary, shadow);
    rows.push({
      query,
      ...comparison,
      primaryTop: firstText(primary),
      shadowTop: firstText(shadow),
    });
  }
  return rows;
}

export async function benchmarkSearchProfiles(
  backend: FreeTextBackend,
  scope: MemoryScope,
  cases: SearchBenchmarkCase[],
  profiles: SearchBenchmarkProfile[],
  options: { maxItems: number; maxContextChars?: number },
): Promise<SearchBenchmarkRow[]> {
  const rows: SearchBenchmarkRow[] = [];

  for (const testCase of cases) {
    const results = await Promise.all(
      profiles.map(async (profile) => {
        const hits = await backend.search(testCase.query, scope, {
          maxItems: options.maxItems,
          maxContextChars: options.maxContextChars,
          includeSessionScope: backend.provider === "mem0",
          ...(profile.options ?? {}),
        });
        return {
          name: profile.name,
          count: hits.length,
          top: firstText(hits),
          top1Hit: evaluateTop1(hits, testCase.expected),
          top5Hit: evaluateTop5(hits, testCase.expected),
          durableCount: hits.filter((item) => item.metadata?.quality === "durable").length,
          transientCount: hits.filter((item) => item.metadata?.quality === "transient").length,
          expectedKindHits: testCase.expectedKind
            ? hits.filter((item) => item.metadata?.memory_kind === testCase.expectedKind).length
            : 0,
        };
      }),
    );

    rows.push({
      id: testCase.id,
      query: testCase.query,
      expected: testCase.expected,
      expectedKind: testCase.expectedKind,
      profiles: results,
    });
  }

  return rows;
}

export function summarizeSearchBenchmark(rows: SearchBenchmarkRow[]): SearchBenchmarkSummary {
  const totals = new Map<string, SearchBenchmarkSummary[number] & { cases: number; top1Eligible: number; top5Eligible: number }>();

  for (const row of rows) {
    for (const profile of row.profiles) {
      const current = totals.get(profile.name) ?? {
        name: profile.name,
        top1Hits: 0,
        top5Hits: 0,
        durableHits: 0,
        transientHits: 0,
        expectedKindHits: 0,
        cases: 0,
        top1Eligible: 0,
        top5Eligible: 0,
      };
      current.cases++;
      if (row.expected) {
        current.top1Eligible++;
        current.top5Eligible++;
        current.top1Hits += profile.top1Hit ? 1 : 0;
        current.top5Hits += profile.top5Hit ? 1 : 0;
      }
      current.durableHits += profile.durableCount;
      current.transientHits += profile.transientCount;
      current.expectedKindHits += profile.expectedKindHits;
      totals.set(profile.name, current);
    }
  }

  return Array.from(totals.values()).map((item) => ({
    name: item.name,
    top1Hits: item.top1Hits,
    top5Hits: item.top5Hits,
    top1Rate: item.top1Eligible > 0 ? Number((item.top1Hits / item.top1Eligible).toFixed(3)) : undefined,
    top5Rate: item.top5Eligible > 0 ? Number((item.top5Hits / item.top5Eligible).toFixed(3)) : undefined,
    durableHits: item.durableHits,
    transientHits: item.transientHits,
    expectedKindHits: item.expectedKindHits,
  }));
}

export function formatSearchBenchmarkReport(rows: SearchBenchmarkRow[]): string {
  const summary = summarizeSearchBenchmark(rows);
  const lines = [
    "Metadata Search Benchmark",
    "═════════════════════════",
    "",
    "Summary:",
    ...summary.map((item) => {
      const parts = [
        `${item.name}`,
        item.top1Rate !== undefined ? `top1=${item.top1Hits}/${rows.length} (${item.top1Rate})` : "",
        item.top5Rate !== undefined ? `top5=${item.top5Hits}/${rows.length} (${item.top5Rate})` : "",
        `durableHits=${item.durableHits}`,
        `transientHits=${item.transientHits}`,
        `expectedKindHits=${item.expectedKindHits}`,
      ].filter(Boolean);
      return `  - ${parts.join(" | ")}`;
    }),
    "",
  ];

  for (const row of rows) {
    lines.push(`Case ${row.id}: ${row.query}`);
    if (row.expected) lines.push(`  expected: ${row.expected}`);
    if (row.expectedKind) lines.push(`  expectedKind: ${row.expectedKind}`);
    for (const profile of row.profiles) {
      lines.push(
        `  ${profile.name}: count=${profile.count} durable=${profile.durableCount} transient=${profile.transientCount} kindHits=${profile.expectedKindHits}${profile.top ? ` | top=${profile.top}` : ""}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function formatBenchmarkReport(
  primaryProvider: string,
  shadowProvider: string,
  rows: BackendBenchmarkRow[],
): string {
  const lines = [
    "Memory Backend Benchmark",
    "════════════════════════",
    `Primary: ${primaryProvider}`,
    `Shadow:  ${shadowProvider}`,
    "",
  ];

  for (const row of rows) {
    lines.push(`Query: ${row.query}`);
    lines.push(`  ${primaryProvider}: ${row.primaryCount} hit(s)${row.primaryTop ? ` | top: ${row.primaryTop}` : ""}`);
    lines.push(`  ${shadowProvider}: ${row.shadowCount} hit(s)${row.shadowTop ? ` | top: ${row.shadowTop}` : ""}`);
    lines.push(`  overlap: ${row.overlapCount}`);
    if (row.primaryOnly.length > 0) {
      lines.push(`  ${primaryProvider}-only: ${row.primaryOnly.slice(0, 2).map((item) => item.text).join(" | ")}`);
    }
    if (row.shadowOnly.length > 0) {
      lines.push(`  ${shadowProvider}-only: ${row.shadowOnly.slice(0, 2).map((item) => item.text).join(" | ")}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function firstText(items: MemuMemoryRecord[]): string | undefined {
  const text = items[0]?.text?.trim();
  return text ? text : undefined;
}

function evaluateTop1(items: MemuMemoryRecord[], expected: string | undefined): boolean | undefined {
  if (!expected) return undefined;
  const top = firstText(items);
  return Boolean(top && top.toLowerCase().includes(expected.trim().toLowerCase()));
}

function evaluateTop5(items: MemuMemoryRecord[], expected: string | undefined): boolean | undefined {
  if (!expected) return undefined;
  const normalized = expected.trim().toLowerCase();
  return items.some((item) => item.text.toLowerCase().includes(normalized));
}
