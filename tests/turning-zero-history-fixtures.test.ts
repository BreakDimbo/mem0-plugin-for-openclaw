import { TURNING_ZERO_HISTORY_FACTS, TURNING_ZERO_RECALL_CASES } from "../scripts/turning-zero-history-fixtures.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ids = new Set(TURNING_ZERO_HISTORY_FACTS.map((item) => item.id));
assert(TURNING_ZERO_HISTORY_FACTS.length === 50, `expected 50 facts, got ${TURNING_ZERO_HISTORY_FACTS.length}`);
assert(ids.size === 50, "fact ids must be unique");
assert(TURNING_ZERO_HISTORY_FACTS.every((item) => item.text.trim().length > 0), "facts must have text");
assert(TURNING_ZERO_HISTORY_FACTS.every((item) => item.sourceSession.length > 0), "facts must have source session");
assert(TURNING_ZERO_RECALL_CASES.length >= 8, "expected recall cases");

console.log("turning-zero-history-fixtures.test.ts ok");
