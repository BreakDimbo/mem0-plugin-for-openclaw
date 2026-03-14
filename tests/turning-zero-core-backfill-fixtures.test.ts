import { TURNING_ZERO_CORE_BACKFILL_ITEMS } from "../scripts/turning-zero-core-backfill-fixtures.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const keys = new Set(TURNING_ZERO_CORE_BACKFILL_ITEMS.map((item) => item.key));

assert(TURNING_ZERO_CORE_BACKFILL_ITEMS.length >= 40, "should backfill at least 40 stable core facts");
assert(keys.size === TURNING_ZERO_CORE_BACKFILL_ITEMS.length, "core backfill keys must be unique");
assert(TURNING_ZERO_CORE_BACKFILL_ITEMS.every((item) => item.value.trim().length > 0), "all values must be non-empty");
assert(TURNING_ZERO_CORE_BACKFILL_ITEMS.some((item) => item.key === "identity.timezone"), "timezone fact must be present");
assert(TURNING_ZERO_CORE_BACKFILL_ITEMS.some((item) => item.key === "general.memory_architecture.layer4"), "architecture layer facts must be present");

console.log("turning-zero-core-backfill-fixtures.test.ts ok");
