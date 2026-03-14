import type { MemuMemoryRecord } from "../../types.js";

export type BackendCompareResult = {
  primaryCount: number;
  shadowCount: number;
  overlapCount: number;
  primaryOnly: MemuMemoryRecord[];
  shadowOnly: MemuMemoryRecord[];
};

function memoryKey(item: MemuMemoryRecord): string {
  const text = item.text.trim().toLowerCase();
  if (text) return text;
  return item.id ?? "";
}

export function compareMemorySets(primary: MemuMemoryRecord[], shadow: MemuMemoryRecord[]): BackendCompareResult {
  const shadowKeys = new Set(shadow.map(memoryKey));
  const primaryKeys = new Set(primary.map(memoryKey));

  const primaryOnly = primary.filter((item) => !shadowKeys.has(memoryKey(item)));
  const shadowOnly = shadow.filter((item) => !primaryKeys.has(memoryKey(item)));

  return {
    primaryCount: primary.length,
    shadowCount: shadow.length,
    overlapCount: primary.length - primaryOnly.length,
    primaryOnly,
    shadowOnly,
  };
}
