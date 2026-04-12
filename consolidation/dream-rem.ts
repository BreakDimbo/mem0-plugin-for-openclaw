import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { RecallSignalStore } from "./signal-store.js";
import type { PhaseSignalStore } from "./phase-signal-store.js";
import type { DreamingConfig } from "../types.js";
import type { LLMConsolidator } from "./llm-consolidator.js";
import type { ShortTermRecallEntry } from "./types.js";

export async function runRemPhase(params: {
  signals: RecallSignalStore;
  phaseSignals: PhaseSignalStore;
  config: DreamingConfig;
  llm?: LLMConsolidator;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}): Promise<{
  patternsDetected: number;
  signalBoosts: number;
  diary?: string;
}> {
  const { signals, phaseSignals, config, llm, logger } = params;

  // 1. entries = signals.getAll().filter(e => !e.promotedAt)
  const entries = signals.getAll().filter((e) => !e.promotedAt);

  // 2. Build tagToEntries Map<string, Set<entryKey>>
  const tagToEntries = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const tag of entry.conceptTags) {
      let set = tagToEntries.get(tag);
      if (!set) {
        set = new Set<string>();
        tagToEntries.set(tag, set);
      }
      set.add(entry.key);
    }
  }

  // 3. Detect patterns: pairs of tags co-occurring in 3+ entries
  // Cap unique tags at 50 (by entry count desc) before pair generation
  const tags = [...tagToEntries.keys()];
  if (tags.length > 50) {
    tags.sort((a, b) => tagToEntries.get(b)!.size - tagToEntries.get(a)!.size);
    tags.length = 50;
  }

  type Pattern = { tags: [string, string]; entries: Set<string> };
  const patterns: Pattern[] = [];

  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const setA = tagToEntries.get(tags[i])!;
      const setB = tagToEntries.get(tags[j])!;
      // Iterate the smaller set for efficiency
      const smaller = setA.size <= setB.size ? setA : setB;
      const larger = setA.size <= setB.size ? setB : setA;
      const intersection = new Set<string>();
      for (const key of smaller) {
        if (larger.has(key)) {
          intersection.add(key);
        }
      }
      if (intersection.size >= 3) {
        patterns.push({ tags: [tags[i], tags[j]], entries: intersection });
      }
    }
  }

  // 4. Record remHit for entries in patterns with cross-day recurrence
  const boostedKeys = new Set<string>();
  for (const pattern of patterns) {
    for (const entryKey of pattern.entries) {
      if (boostedKeys.has(entryKey)) continue;
      const entry = signals.get(entryKey);
      if (entry && entry.recallDays.length >= 2) {
        phaseSignals.recordRemHit(entryKey);
        boostedKeys.add(entryKey);
      }
    }
  }

  // 5. Optional diary generation
  let diary: string | undefined;
  if (llm && config.llmDiary && patterns.length > 0) {
    const prompt = buildDiaryPrompt(patterns.slice(0, 10), entries);
    try {
      diary = await llm.generateDiary(prompt);
      if (diary && diary.trim()) {
        const line = JSON.stringify({ runAt: new Date().toISOString(), diary: diary.trim() }) + "\n";
        await mkdir(dirname(config.diaryPath), { recursive: true });
        await appendFile(config.diaryPath, line, "utf-8");
      }
    } catch (err) {
      logger.warn(`rem-phase: diary generation failed — ${String(err)}`);
    }
  }

  return {
    patternsDetected: patterns.length,
    signalBoosts: boostedKeys.size,
    diary,
  };
}

function buildDiaryPrompt(
  patterns: Array<{ tags: [string, string]; entries: Set<string> }>,
  entries: ShortTermRecallEntry[],
): string {
  const entryMap = new Map(entries.map((e) => [e.key, e]));
  const lines = patterns.map((p, i) => {
    const snippets = [...p.entries]
      .slice(0, 5)
      .map((key) => {
        const entry = entryMap.get(key);
        return entry ? `"${entry.snippet.slice(0, 40)}"` : `"${key}"`;
      })
      .join(", ");
    return `${i + 1}. Tags [${p.tags.join(", ")}] in ${p.entries.size} entries: ${snippets}`;
  });
  return (
    "You are a memory analyst. Review the following patterns detected in recalled memories " +
    "and write a brief, insightful diary entry (2-3 sentences) summarizing emerging themes.\n\n" +
    `Patterns:\n${lines.join("\n")}`
  );
}
