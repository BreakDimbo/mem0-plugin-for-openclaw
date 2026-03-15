import { BENCHMARK_CORE_ITEMS } from "../scripts/benchmark-core-fixtures.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const keys = new Set(BENCHMARK_CORE_ITEMS.map((item) => item.key));

assert(BENCHMARK_CORE_ITEMS.length >= 40, `should have at least 40 core facts, got ${BENCHMARK_CORE_ITEMS.length}`);
assert(keys.size === BENCHMARK_CORE_ITEMS.length, "core backfill keys must be unique");
assert(BENCHMARK_CORE_ITEMS.every((item) => item.value.trim().length > 0), "all values must be non-empty");
assert(BENCHMARK_CORE_ITEMS.some((item) => item.key === "identity.timezone"), "timezone fact must be present");
assert(BENCHMARK_CORE_ITEMS.some((item) => item.key === "architecture.layer4"), "architecture layer facts must be present");

console.log("benchmark-core-fixtures.test.ts ok");
