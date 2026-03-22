// ============================================================================
// Consolidation sub-system types
// Shared by scorer, runner, scheduler, CLI dashboard
// ============================================================================

// ── Scoring ──────────────────────────────────────────────────────────────────

/** Raw factor values before weighting */
export type ScoreFactors = {
  /** 0–1: exponential decay based on lastModified (Ebbinghaus) */
  recency: number;
  /** 0–1: normalized access frequency relative to collection median */
  accessFreq: number;
  /** 0–1: semantic novelty vs. other records in same category */
  novelty: number;
  /** 0–1: type prior (profile=1.0, technical=0.8, general=0.5, …) */
  typePrior: number;
  /** 0–1: explicit importance flag on the record (1.0 if set, 0 otherwise) */
  explicitImportance: number;
};

export type ScoredMemory<T> = {
  record: T;
  factors: ScoreFactors;
  /** Weighted composite score 0–1 */
  score: number;
};

// ── Verdicts ─────────────────────────────────────────────────────────────────

/** What to do with a memory record after scoring */
export type MemoryVerdict =
  | "keep"       // score ≥ keepThreshold
  | "downgrade"  // score in [downgradeThreshold, keepThreshold)
  | "merge"      // duplicate/near-duplicate of another record
  | "archive"    // score < archiveThreshold but may still hold value
  | "delete";    // score < deleteThreshold (truly stale)

/** LLM consolidator verdict for boundary-zone records */
export type LLMVerdict = {
  id: string;
  verdict: MemoryVerdict;
  reason: string;
  /** Optional merged text when verdict is "merge" */
  mergedValue?: string;
};

// ── Reports ──────────────────────────────────────────────────────────────────

export type ConsolidationCycle = "daily" | "weekly" | "monthly";

export type ConsolidationReportEntry = {
  id: string;
  key?: string;      // core memory key (if applicable)
  category: string;
  snippet: string;   // first 80 chars of value
  score: number;
  factors: ScoreFactors;
  verdict: MemoryVerdict;
  reason: string;
};

export type ConsolidationReport = {
  cycle: ConsolidationCycle;
  runAt: string;          // ISO timestamp
  dryRun: boolean;
  totalScored: number;
  kept: number;
  downgraded: number;
  merged: number;
  archived: number;
  deleted: number;
  llmCalled: boolean;
  entries: ConsolidationReportEntry[];
};

// ── Scheduler state ──────────────────────────────────────────────────────────

export type ConsolidationState = {
  lastDailyRun?: string;    // ISO timestamp
  lastWeeklyRun?: string;
  lastMonthlyRun?: string;
  totalRuns: number;
  lastReport?: ConsolidationReport;
};
