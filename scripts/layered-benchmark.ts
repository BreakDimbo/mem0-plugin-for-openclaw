import type { E2ECase } from "./benchmark-e2e-fixtures.js";

export type LayeredBenchmarkRow = {
  id: string;
  query: string;
  expected: string;
  injectedContext: string;
  injectionHit: boolean;
  answer: string;
  answerHit: boolean;
  durationMs: number;
};

export function normalizeBenchmarkText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、“”"'`·:：；;（）()【】\[\]\-]/g, "");
}

export function includesExpected(text: string, expected: string): boolean {
  const normalizedExpected = normalizeBenchmarkText(expected);
  if (!normalizedExpected) return false;
  return normalizeBenchmarkText(text).includes(normalizedExpected);
}

export function summarizeLayeredRows(cases: E2ECase[], rows: LayeredBenchmarkRow[]) {
  const injectionHits = rows.filter((row) => row.injectionHit).length;
  const answerHits = rows.filter((row) => row.answerHit).length;
  const injectionOnly = rows.filter((row) => row.injectionHit && !row.answerHit).length;
  const answerWithoutInjection = rows.filter((row) => !row.injectionHit && row.answerHit).length;
  const missedBoth = rows.filter((row) => !row.injectionHit && !row.answerHit).length;
  const avgDurationMs = Math.round(rows.reduce((sum, row) => sum + row.durationMs, 0) / Math.max(rows.length, 1));

  return {
    cases: cases.length,
    injectionHits,
    injectionHitRate: Number((injectionHits / Math.max(cases.length, 1)).toFixed(3)),
    answerHits,
    answerHitRate: Number((answerHits / Math.max(cases.length, 1)).toFixed(3)),
    injectionOnly,
    answerWithoutInjection,
    missedBoth,
    avgDurationMs,
  };
}
