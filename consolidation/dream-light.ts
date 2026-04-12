import type { DreamingConfig } from "../types.js";
import { trigramSimilarity } from "../metadata.js";
import type { RecallSignalStore } from "./signal-store.js";
import type { PhaseSignalStore } from "./phase-signal-store.js";
import type { ShortTermRecallEntry } from "./types.js";

type Logger = { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

function union<T>(a: T[], b: T[]): T[] {
  return Array.from(new Set([...a, ...b]));
}

export async function runLightPhase(params: {
  signals: RecallSignalStore;
  phaseSignals: PhaseSignalStore;
  config: DreamingConfig;
  logger: Logger;
}): Promise<{
  candidates: ShortTermRecallEntry[];
  deduped: number;
  lightHitsRecorded: number;
}> {
  const { signals, phaseSignals, config } = params;

  // 1. Get non-promoted entries
  const entries = signals.getAll().filter((e) => !e.promotedAt);

  // 2. Sort by recallCount DESC (strongest absorbs rest)
  entries.sort((a, b) => b.recallCount - a.recallCount);

  const duplicate = new Set<string>();

  // 3. Pairwise deduplication
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    if (duplicate.has(a.key)) continue;

    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j];
      if (duplicate.has(b.key)) continue;

      if (trigramSimilarity(a.snippet, b.snippet) >= config.dedupeThreshold) {
        // Merge B into A
        a.recallCount += b.recallCount;
        a.totalScore += b.totalScore;
        a.maxScore = Math.max(a.maxScore, b.maxScore);
        a.queryHashes = union(a.queryHashes, b.queryHashes).slice(0, config.maxQueryHashes);
        a.recallDays = union(a.recallDays, b.recallDays).slice(0, config.maxRecallDays);
        a.conceptTags = union(a.conceptTags, b.conceptTags).slice(0, config.maxConceptTags);

        signals.delete(b.key);
        duplicate.add(b.key);
      }
    }
  }

  // 4. Candidates are entries not marked as duplicate
  const candidates = entries.filter((e) => !duplicate.has(e.key));

  // 5. Record light hits
  for (const candidate of candidates) {
    phaseSignals.recordLightHit(candidate.key);
  }

  return {
    candidates,
    deduped: duplicate.size,
    lightHitsRecorded: candidates.length,
  };
}
