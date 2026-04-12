// ============================================================================
// Dream Scoring Engine (DREAM-04)
// ============================================================================

import type { DreamingConfig, DreamScoringWeights } from "../types.js";
import type { ShortTermRecallEntry, PhaseSignalEntry, DreamScoreFactors } from "./types.js";

const MS_PER_DAY = 86400000;

function parseDateToEpochMs(dateStr: string): number {
  // Parse YYYY-MM-DD as UTC midnight to avoid timezone issues
  const [year, month, day] = dateStr.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}

export class DreamScorer {
  private weights: DreamScoringWeights;
  private promotion: DreamingConfig["scoring"]["promotion"];

  constructor(config: DreamingConfig) {
    this.promotion = config.scoring.promotion;
    let weights = { ...config.scoring.weights };

    if (config.normalizeWeights) {
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      if (sum > 0 && Math.abs(sum - 1.0) > 1e-12) {
        weights = {
          frequency: weights.frequency / sum,
          relevance: weights.relevance / sum,
          diversity: weights.diversity / sum,
          recency: weights.recency / sum,
          consolidation: weights.consolidation / sum,
          conceptual: weights.conceptual / sum,
        };
      }
    }

    this.weights = weights;
  }

  score(
    entry: ShortTermRecallEntry,
    phaseSignal?: PhaseSignalEntry,
    now = Date.now(),
  ): { score: number; factors: DreamScoreFactors } {
    const frequency = Math.min(1, Math.log1p(entry.recallCount) / Math.log1p(10));
    const relevance = Math.min(1, entry.totalScore / Math.max(1, entry.recallCount));
    const diversity = Math.min(1, Math.max(entry.queryHashes.length, entry.recallDays.length) / 5);

    const ageDays = Math.max(0, (now - entry.lastRecalledAt) / MS_PER_DAY);
    const recency = Math.exp((-Math.LN2 / 14) * ageDays);

    let spacingRaw = 0;
    let spanRaw = 0;
    if (entry.recallDays.length >= 2) {
      spacingRaw = Math.min(1, Math.log1p(entry.recallDays.length - 1) / Math.log1p(4));
      const sortedDays = [...entry.recallDays].sort();
      const firstDay = parseDateToEpochMs(sortedDays[0]);
      const lastDay = parseDateToEpochMs(sortedDays[sortedDays.length - 1]);
      const spanDays = (lastDay - firstDay) / MS_PER_DAY;
      spanRaw = Math.min(1, spanDays / 30);
    }
    const consolidation = Math.min(1, Math.max(spacingRaw * 0.55 + spanRaw * 0.45, entry.recallDays.length / 5));

    const conceptual = Math.min(1, entry.conceptTags.length / 6);

    let lightBoost = 0;
    let remBoost = 0;
    if (phaseSignal) {
      const daysSinceLastLight = phaseSignal.lastLightAt !== undefined
        ? (now - phaseSignal.lastLightAt) / MS_PER_DAY
        : Infinity;
      lightBoost = 0.05 * Math.min(1, phaseSignal.lightHits / 3) * Math.exp((-Math.LN2 / 7) * daysSinceLastLight);

      const daysSinceLastRem = phaseSignal.lastRemAt !== undefined
        ? (now - phaseSignal.lastRemAt) / MS_PER_DAY
        : Infinity;
      remBoost = 0.08 * Math.min(1, phaseSignal.remHits / 2) * Math.exp((-Math.LN2 / 7) * daysSinceLastRem);
    }
    const phaseBoost = Math.min(0.13, lightBoost + remBoost);

    const factors: DreamScoreFactors = {
      frequency,
      relevance,
      diversity,
      recency,
      consolidation,
      conceptual,
      phaseBoost,
    };

    const rawScore =
      this.weights.frequency * frequency +
      this.weights.relevance * relevance +
      this.weights.diversity * diversity +
      this.weights.recency * recency +
      this.weights.consolidation * consolidation +
      this.weights.conceptual * conceptual +
      phaseBoost;

    const score = Math.max(0, Math.min(1, rawScore));

    return { score, factors };
  }

  scoreBatch(
    entries: ShortTermRecallEntry[],
    phaseSignals: Map<string, PhaseSignalEntry>,
    now = Date.now(),
  ): Array<{ entry: ShortTermRecallEntry; score: number; factors: DreamScoreFactors }> {
    const scored = entries.map((entry) => {
      const phaseSignal = phaseSignals.get(entry.key);
      const { score, factors } = this.score(entry, phaseSignal, now);
      return { entry, score, factors };
    });

    // Sort by score DESC, ties broken by key ASC (stable sort)
    return scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.key.localeCompare(b.entry.key);
    });
  }

  meetsPromotionThreshold(
    entry: ShortTermRecallEntry,
    score: number,
  ): { eligible: boolean; reasons: string[] } {
    const reasons: string[] = [];

    if (score < this.promotion.minScore) {
      reasons.push(`score ${score.toFixed(2)} < minScore ${this.promotion.minScore}`);
    }
    if (entry.recallCount < this.promotion.minRecallCount) {
      reasons.push(`recallCount ${entry.recallCount} < minRecallCount ${this.promotion.minRecallCount}`);
    }
    if (entry.queryHashes.length < this.promotion.minUniqueQueries) {
      reasons.push(`queryHashes ${entry.queryHashes.length} < minUniqueQueries ${this.promotion.minUniqueQueries}`);
    }
    if (entry.promotedAt !== undefined) {
      reasons.push("already promoted");
    }

    return { eligible: reasons.length === 0, reasons };
  }
}
