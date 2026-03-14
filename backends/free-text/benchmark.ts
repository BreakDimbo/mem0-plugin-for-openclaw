import type { MemoryScope, MemuMemoryRecord } from "../../types.js";
import type { FreeTextBackend } from "./base.js";
import { compareMemorySets, type BackendCompareResult } from "./compare.js";

export type BackendBenchmarkRow = BackendCompareResult & {
  query: string;
  primaryTop?: string;
  shadowTop?: string;
};

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
