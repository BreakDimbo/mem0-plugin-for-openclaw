import { BENCHMARK_E2E_CASES } from "../scripts/benchmark-e2e-fixtures.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(BENCHMARK_E2E_CASES.length === 70, `expected 70 cases, got ${BENCHMARK_E2E_CASES.length}`);
assert(
  new Set(BENCHMARK_E2E_CASES.map((item) => item.id)).size === 70,
  "case ids must be unique",
);
assert(BENCHMARK_E2E_CASES.every((item) => item.query.trim().length > 0), "queries must be non-empty");
assert(BENCHMARK_E2E_CASES.every((item) => item.expected.trim().length > 0), "expected values must be non-empty");

console.log("benchmark-e2e-fixtures.test.ts ok");
