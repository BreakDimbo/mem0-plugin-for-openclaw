import { includesExpected, normalizeBenchmarkText, summarizeLayeredRows } from "../scripts/layered-benchmark.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

assertEqual(normalizeBenchmarkText("UTC+8。"), "utc+8", "normalize punctuation");
assert(includesExpected("用户的时区是 UTC+8。", "UTC+8"), "expected substring should match after normalization");

const summary = summarizeLayeredRows(
  [
    { id: "1", query: "q1", expected: "a" },
    { id: "2", query: "q2", expected: "b" },
  ],
  [
    {
      id: "1",
      query: "q1",
      expected: "a",
      injectedContext: "a",
      injectionHit: true,
      answer: "没有",
      answerHit: false,
      durationMs: 100,
    },
    {
      id: "2",
      query: "q2",
      expected: "b",
      injectedContext: "",
      injectionHit: false,
      answer: "b",
      answerHit: true,
      durationMs: 200,
    },
  ],
);

assertEqual(summary.injectionHits, 1, "injection hits");
assertEqual(summary.answerHits, 1, "answer hits");
assertEqual(summary.injectionOnly, 1, "injection only cases");
assertEqual(summary.answerWithoutInjection, 1, "answer without injection cases");
assertEqual(summary.missedBoth, 0, "missed both cases");

console.log("layered-benchmark.test.ts ok");
