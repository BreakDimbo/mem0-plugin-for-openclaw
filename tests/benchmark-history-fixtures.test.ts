import { BENCHMARK_HISTORY_FACTS, BENCHMARK_RECALL_CASES } from "../scripts/benchmark-history-fixtures.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ids = new Set(BENCHMARK_HISTORY_FACTS.map((item) => item.id));
assert(BENCHMARK_HISTORY_FACTS.length === 45, `expected 45 facts, got ${BENCHMARK_HISTORY_FACTS.length}`);
assert(ids.size === 45, "fact ids must be unique");
assert(BENCHMARK_HISTORY_FACTS.every((item) => item.text.trim().length > 0), "facts must have text");
assert(BENCHMARK_HISTORY_FACTS.every((item) => item.sourceLabel.length > 0), "facts must have source label");
assert(BENCHMARK_RECALL_CASES.length >= 8, "expected recall cases");

console.log("benchmark-history-fixtures.test.ts ok");
