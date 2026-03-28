// ============================================================================
// ImportanceScorer — five-factor scoring + Ebbinghaus forgetting curve
//
// Five factors (A-MAC inspired):
//   1. recency       — exponential decay R = e^(-Δt / S)  (Ebbinghaus)
//   2. accessFreq    — normalized access frequency vs. collection median
//   3. novelty       — inverse of max trigram similarity to other records
//   4. typePrior     — static weight by tier (profile=1.0, technical=0.8, …)
//   5. explicitImportance — `importance` field on the record (1.0 if ≥ 0.8)
// ============================================================================

import type { CoreMemoryRecord } from "../types.js";
import type { ScoreFactors, ScoredMemory } from "./types.js";
import type { ConsolidationConfig } from "../types.js";
import { trigramSimilarity } from "../metadata.js";

// ── Type prior by tier ───────────────────────────────────────────────────────

const TIER_PRIOR: Record<string, number> = {
  profile:   1.0,
  technical: 0.8,
  general:   0.5,
};

function typePriorForRecord(r: CoreMemoryRecord): number {
  if (r.tier && TIER_PRIOR[r.tier] !== undefined) return TIER_PRIOR[r.tier];
  if (r.category && TIER_PRIOR[r.category] !== undefined) return TIER_PRIOR[r.category];
  return 0.5;
}

// ── Ebbinghaus recency decay ─────────────────────────────────────────────────

/**
 * R = e^(-Δt_days / stabilityDays)
 * Returns value in [0, 1]: 1 = just updated, 0 = very old.
 */
function recencyScore(record: CoreMemoryRecord, stabilityDays: number): number {
  const ts = record.touchedAt ?? record.updatedAt ?? record.createdAt;
  if (!ts) return 0.5; // unknown age → neutral
  if (stabilityDays <= 0) return 0.5; // guard against division by zero
  const deltaDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  return Math.exp(-deltaDays / stabilityDays);
}

// ── Access frequency ─────────────────────────────────────────────────────────

/**
 * Count how many times a record has been touched relative to the collection.
 * We approximate frequency by comparing `touchedAt - createdAt` (proxy for
 * # of re-touches) normalised by the median of the collection.
 *
 * Real touch counts aren't stored yet, so we use age-adjusted gap heuristic:
 *   touches ≈ (touchedAt - createdAt) / ageMs   (fraction of life that was "active")
 */
function accessFreqScore(record: CoreMemoryRecord, allRecords: CoreMemoryRecord[]): number {
  function touchProxy(r: CoreMemoryRecord): number {
    if (!r.touchedAt || !r.createdAt) return 0;
    const age = r.touchedAt - r.createdAt;
    if (age <= 0) return 0;
    return age; // larger gap = accessed recently after long storage
  }

  const proxies = allRecords.map(touchProxy);
  const sorted = [...proxies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (median === 0) return 0.5;

  const myProxy = touchProxy(record);
  // Sigmoid-like normalisation: score = 1 / (1 + e^(-3*(x/median - 1)))
  const x = myProxy / median;
  return 1 / (1 + Math.exp(-3 * (x - 1)));
}

// ── Novelty (inverse of max similarity to peer records) ──────────────────────

/**
 * Novelty = 1 - max(trigram_similarity(value, peer.value)) for peers in same category.
 * If a record is very similar to another, it has low novelty (likely redundant).
 */
function noveltyScore(record: CoreMemoryRecord, allRecords: CoreMemoryRecord[]): number {
  const peers = allRecords.filter(
    (r) => r.id !== record.id && r.category === record.category,
  );
  if (peers.length === 0) return 1.0; // unique in category

  let maxSim = 0;
  for (const peer of peers) {
    const sim = trigramSimilarity(record.value, peer.value);
    if (sim > maxSim) maxSim = sim;
  }
  return 1 - maxSim;
}

// ── Explicit importance ───────────────────────────────────────────────────────

function explicitImportanceScore(record: CoreMemoryRecord): number {
  const imp = record.importance;
  if (imp === undefined || imp === null) return 0;
  // Auto-normalize: stored importance can be 0-1 OR 0-10 scale.
  // If value > 1, assume 0-10 and divide by 10.
  const normalized = imp > 1 ? imp / 10 : imp;
  return Math.min(1, Math.max(0, normalized));
}

// ── Main scorer ───────────────────────────────────────────────────────────────

export class ImportanceScorer {
  private readonly config: ConsolidationConfig;

  constructor(config: ConsolidationConfig) {
    this.config = config;
  }

  /**
   * Score a single record in the context of the full collection.
   * Returns a ScoredMemory with raw factors and composite score.
   */
  scoreOne(
    record: CoreMemoryRecord,
    allRecords: CoreMemoryRecord[],
  ): ScoredMemory<CoreMemoryRecord> {
    const { decay, weights } = this.config;

    const factors: ScoreFactors = {
      recency:            recencyScore(record, decay.stabilityDays),
      accessFreq:         accessFreqScore(record, allRecords),
      novelty:            noveltyScore(record, allRecords),
      typePrior:          typePriorForRecord(record),
      explicitImportance: explicitImportanceScore(record),
    };

    const score =
      factors.recency            * weights.recency +
      factors.accessFreq         * weights.accessFreq +
      factors.novelty            * weights.novelty +
      factors.typePrior          * weights.typePrior +
      factors.explicitImportance * weights.explicitImportance;

    return { record, factors, score: Math.min(1, Math.max(0, score)) };
  }

  /**
   * Score all records in a collection.
   */
  scoreAll(records: CoreMemoryRecord[]): ScoredMemory<CoreMemoryRecord>[] {
    return records.map((r) => this.scoreOne(r, records));
  }
}
