// ============================================================================
// Deep Phase -- Score and Promote (DREAM-07)
// ============================================================================

import type { DreamingConfig, MemoryScope, MemuMemoryRecord } from "../types.js";
import type { CoreMemoryRepository } from "../core-repository.js";
import type { FreeTextBackend } from "../backends/free-text/base.js";
import type { DreamScorer } from "./dream-scorer.js";
import type { RecallSignalStore } from "./signal-store.js";
import type { PhaseSignalStore } from "./phase-signal-store.js";
import type { DreamPromotion, DreamScoreFactors, ShortTermRecallEntry } from "./types.js";

type Logger = { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

export async function runDeepPhase(params: {
  candidates: ShortTermRecallEntry[];
  phaseSignals: PhaseSignalStore;
  signals: RecallSignalStore;
  scorer: DreamScorer;
  coreRepo: CoreMemoryRepository;
  freeTextBackend: FreeTextBackend;
  scope: MemoryScope;
  config: DreamingConfig;
  logger: Logger;
  dryRun: boolean;
}): Promise<{
  promotions: DreamPromotion[];
  totalScored: number;
  highScoreCount: number;
}> {
  const { candidates, phaseSignals, signals, scorer, coreRepo, freeTextBackend, scope, config, logger, dryRun } = params;

  // 1. Score all candidates
  const scored = scorer.scoreBatch(candidates, phaseSignals.getAll());

  // 2. Pre-fetch all free-text memories once and index by ID
  const allFreeTexts = await freeTextBackend.list(scope, { limit: 5000 });
  const freeTextIndex = new Map<string, MemuMemoryRecord>(
    allFreeTexts.filter((r) => r.id).map((r) => [r.id!, r]),
  );

  const promotions: DreamPromotion[] = [];
  let coreSkipped = 0;

  // 3. Evaluate each scored candidate
  for (const { entry, score, factors } of scored) {
    const { eligible, reasons } = scorer.meetsPromotionThreshold(entry, score);
    if (!eligible) {
      logger.info(`deep-phase: ${entry.key} not eligible: ${reasons.join("; ")}`);
      continue;
    }

    if (entry.layer === "core") {
      logger.info(`already in core, score=${score.toFixed(2)}`);
      coreSkipped++;
      continue;
    }

    if (promotions.length >= config.maxPromotionsPerCycle) {
      break;
    }

    const match = freeTextIndex.get(entry.key);
    if (!match) {
      logger.warn(`deep-phase: memory not found in backend: ${entry.key}`);
      continue;
    }

    const targetKey = `dreaming.${entry.key.slice(0, 12)}`;

    if (!dryRun) {
      try {
        await coreRepo.upsert(scope, {
          key: targetKey,
          value: match.text,
          category: "general",
          source: "dreaming",
          importance: score,
          metadata: { dreamScore: score, promotedFrom: "free-text", originalId: entry.key },
        });
        signals.markPromoted(entry.key);
      } catch (err) {
        logger.warn(`deep-phase: promotion failed for ${entry.key}:`, err);
        continue;
      }
    }

    promotions.push({
      sourceKey: entry.key,
      sourceLayer: "free-text",
      targetKey,
      score,
      factors,
      reason: `Promoted free-text memory with score ${score.toFixed(2)}`,
    });
  }

  return {
    promotions,
    totalScored: scored.length,
    highScoreCount: promotions.length + coreSkipped,
  };
}
