// ============================================================================
// ConsolidationRunner — scores all core and free-text memory records
//
// T3: core memory dry-run report
// T4: core memory actual writes + dead-letter protection
// T5: free-text (mem0) extension
// ============================================================================

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { CoreMemoryRecord, MemuMemoryRecord, ConsolidationConfig, MemoryScope } from "../types.js";
import type { CoreMemoryRepository } from "../core-repository.js";
import type { FreeTextBackend } from "../backends/free-text/base.js";
import type {
  ConsolidationCycle,
  ConsolidationReport,
  ConsolidationReportEntry,
  LLMVerdict,
  MemoryVerdict,
  ScoredMemory,
} from "./types.js";
import { ImportanceScorer } from "./scorer.js";
import { LLMConsolidator } from "./llm-consolidator.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

// ── Verdict assignment ────────────────────────────────────────────────────────

function assignVerdict(
  scored: ScoredMemory<CoreMemoryRecord>,
  config: ConsolidationConfig,
): { verdict: MemoryVerdict; reason: string } {
  const { score } = scored;
  const t = config.thresholds;

  if (score >= t.keep) {
    return { verdict: "keep", reason: `score ${score.toFixed(3)} ≥ keep threshold ${t.keep}` };
  }
  if (score >= t.downgrade) {
    return { verdict: "downgrade", reason: `score ${score.toFixed(3)} in [${t.downgrade}, ${t.keep})` };
  }
  if (score >= t.archive) {
    return { verdict: "archive", reason: `score ${score.toFixed(3)} in [${t.archive}, ${t.downgrade})` };
  }
  if (score >= t.delete) {
    return { verdict: "archive", reason: `score ${score.toFixed(3)} in [${t.delete}, ${t.archive})` };
  }
  return { verdict: "delete", reason: `score ${score.toFixed(3)} < delete threshold ${t.delete}` };
}

/** Records that fall in the LLM boundary zone */
function isLLMBoundary(score: number, config: ConsolidationConfig): boolean {
  return score >= config.thresholds.llmLow && score <= config.thresholds.llmHigh;
}

// ── Dead-letter log ───────────────────────────────────────────────────────────

async function appendDeadLetter(
  path: string,
  record: CoreMemoryRecord,
  reason: string,
): Promise<void> {
  const resolved = resolvePath(path);
  await mkdir(dirname(resolved), { recursive: true });
  const line = JSON.stringify({ deletedAt: new Date().toISOString(), reason, record }) + "\n";
  await appendFile(resolved, line, "utf-8");
}

// ── Main runner ───────────────────────────────────────────────────────────────

export class ConsolidationRunner {
  private readonly repo: CoreMemoryRepository;
  private readonly freeTextBackend: FreeTextBackend | undefined;
  private readonly config: ConsolidationConfig;
  private readonly scorer: ImportanceScorer;
  private readonly llm: LLMConsolidator;
  private readonly logger: Logger;

  constructor(
    repo: CoreMemoryRepository,
    config: ConsolidationConfig,
    logger: Logger,
    freeTextBackend?: FreeTextBackend,
  ) {
    this.repo = repo;
    this.freeTextBackend = freeTextBackend;
    this.config = config;
    this.scorer = new ImportanceScorer(config);
    this.llm = new LLMConsolidator(config.llm, logger);
    this.logger = logger;
  }

  /**
   * Run a consolidation cycle.
   *
   * @param scope  — which user/agent's memories to consolidate
   * @param cycle  — "daily" | "weekly" | "monthly" (determines logging label)
   * @param dryRun — when true, computes verdicts but does NOT write anything
   */
  async run(
    scope: MemoryScope,
    cycle: ConsolidationCycle,
    dryRun: boolean,
  ): Promise<ConsolidationReport> {
    const runAt = new Date().toISOString();
    this.logger.info(`consolidation: starting ${cycle} run (dryRun=${dryRun}) scope=${scope.userId}/${scope.agentId}`);

    // 1. Load all records
    const records = await this.repo.list(scope, { limit: 10_000 });
    if (records.length === 0) {
      this.logger.info("consolidation: no records found, skipping");
      return this.emptyReport(cycle, runAt, dryRun);
    }

    // 2. Score all
    const scored = this.scorer.scoreAll(records);

    // 3. First-pass verdicts (score-only)
    const entries: ConsolidationReportEntry[] = [];
    const llmCandidates: ScoredMemory<CoreMemoryRecord>[] = [];

    for (const s of scored) {
      const { verdict, reason } = assignVerdict(s, this.config);

      if (isLLMBoundary(s.score, this.config)) {
        llmCandidates.push(s);
      }

      entries.push({
        id: s.record.id,
        key: s.record.key,
        category: s.record.category ?? "unknown",
        snippet: s.record.value.slice(0, 80),
        score: s.score,
        factors: s.factors,
        verdict,
        reason,
      });
    }

    // 4. LLM override for boundary-zone records
    let llmCalled = false;
    if (this.config.llm.enabled && llmCandidates.length > 0) {
      llmCalled = true;
      const llmVerdicts: LLMVerdict[] = await this.llm.judgeRecords(llmCandidates).catch((err) => {
        this.logger.warn(`consolidation: LLM judge failed: ${String(err)}`);
        return [];
      });

      // Apply LLM overrides
      const llmById = new Map(llmVerdicts.map((v) => [v.id, v]));
      for (const entry of entries) {
        const override = llmById.get(entry.id);
        if (override) {
          entry.verdict = override.verdict;
          entry.reason = `[LLM] ${override.reason}`;
        }
      }
    }

    // 5. Execute (skip when dryRun)
    if (!dryRun) {
      await this.executeVerdicts(scope, entries, scored);
    }

    // 6. Tally
    const tally = { kept: 0, downgraded: 0, merged: 0, archived: 0, deleted: 0 };
    for (const e of entries) {
      if (e.verdict === "keep")           tally.kept++;
      else if (e.verdict === "downgrade") tally.downgraded++;
      else if (e.verdict === "merge")     tally.merged++;
      else if (e.verdict === "archive")   tally.archived++;
      else if (e.verdict === "delete")    tally.deleted++;
    }

    this.logger.info(
      `consolidation: ${cycle} done — ` +
      `keep=${tally.kept} downgrade=${tally.downgraded} archive=${tally.archived} ` +
      `delete=${tally.deleted} llmCandidates=${llmCandidates.length} llmCalled=${llmCalled} dryRun=${dryRun}`,
    );

    return {
      cycle,
      runAt,
      dryRun,
      totalScored: records.length,
      ...tally,
      llmCalled,
      entries,
    };
  }

  /** Apply verdicts to the repository */
  private async executeVerdicts(
    scope: MemoryScope,
    entries: ConsolidationReportEntry[],
    scored: ScoredMemory<CoreMemoryRecord>[],
  ): Promise<void> {
    const scoredById = new Map(scored.map((s) => [s.record.id, s]));

    for (const entry of entries) {
      if (entry.verdict === "delete") {
        const s = scoredById.get(entry.id);
        if (s) {
          // Write to dead-letter before deleting
          await appendDeadLetter(this.config.deadLetterPath, s.record, entry.reason).catch((err) => {
            this.logger.warn(`consolidation: dead-letter write failed: ${String(err)}`);
          });
        }
        await this.repo.delete(scope, { id: entry.id }).catch((err) => {
          this.logger.warn(`consolidation: delete failed for id=${entry.id}: ${String(err)}`);
        });
      }
      // downgrade and archive: no-op for now (importance field update not yet supported in this pass)
      // merge: handled in T5/T6 after LLM integration
    }
  }

  /**
   * Run consolidation on free-text (mem0) records.
   * Adapts MemuMemoryRecord to the scorer's CoreMemoryRecord shape for scoring.
   * Only "delete" verdicts are acted on (calls backend.forget({ memoryId })).
   */
  async runFreeText(
    scope: MemoryScope,
    cycle: ConsolidationCycle,
    dryRun: boolean,
  ): Promise<ConsolidationReport> {
    const backend = this.freeTextBackend;
    const runAt = new Date().toISOString();

    if (!backend) {
      this.logger.info("consolidation-ft: no free-text backend configured, skipping");
      return this.emptyReport(cycle, runAt, dryRun);
    }

    const ftRecords = await backend.list(scope, { limit: 2000 }).catch((err) => {
      this.logger.warn(`consolidation-ft: list failed: ${String(err)}`);
      return [] as MemuMemoryRecord[];
    });

    if (ftRecords.length === 0) {
      return this.emptyReport(cycle, runAt, dryRun);
    }

    // Adapt MemuMemoryRecord → CoreMemoryRecord for scoring
    const adapted: CoreMemoryRecord[] = ftRecords.map((r, i) => ({
      id: r.id ?? `ft-${i}`,
      key: r.category ?? "general",
      value: r.text,
      category: r.category ?? "general",
      scope: r.scope,
      createdAt: r.createdAt,
      updatedAt: r.createdAt,
      touchedAt: r.createdAt,
    }));

    const scored = this.scorer.scoreAll(adapted);
    const entries: ConsolidationReportEntry[] = scored.map((s) => {
      const { verdict, reason } = assignVerdict(s, this.config);
      return {
        id: s.record.id,
        category: s.record.category ?? "unknown",
        snippet: s.record.value.slice(0, 80),
        score: s.score,
        factors: s.factors,
        verdict,
        reason,
      };
    });

    if (!dryRun) {
      for (const entry of entries) {
        if (entry.verdict === "delete" && entry.id && !entry.id.startsWith("ft-")) {
          await backend.forget(scope, { memoryId: entry.id }).catch((err) => {
            this.logger.warn(`consolidation-ft: forget failed for id=${entry.id}: ${String(err)}`);
          });
        }
      }
    }

    const tally = { kept: 0, downgraded: 0, merged: 0, archived: 0, deleted: 0 };
    for (const e of entries) {
      if (e.verdict === "keep")           tally.kept++;
      else if (e.verdict === "downgrade") tally.downgraded++;
      else if (e.verdict === "merge")     tally.merged++;
      else if (e.verdict === "archive")   tally.archived++;
      else if (e.verdict === "delete")    tally.deleted++;
    }

    this.logger.info(
      `consolidation-ft: ${cycle} done — ` +
      `keep=${tally.kept} archive=${tally.archived} delete=${tally.deleted} dryRun=${dryRun}`,
    );

    return {
      cycle, runAt, dryRun,
      totalScored: ftRecords.length,
      ...tally,
      llmCalled: false,
      entries,
    };
  }

  private emptyReport(cycle: ConsolidationCycle, runAt: string, dryRun: boolean): ConsolidationReport {
    return {
      cycle, runAt, dryRun,
      totalScored: 0,
      kept: 0, downgraded: 0, merged: 0, archived: 0, deleted: 0,
      llmCalled: false,
      entries: [],
    };
  }
}

// ── Report persistence ────────────────────────────────────────────────────────

export async function saveReport(statePath: string, report: ConsolidationReport): Promise<void> {
  const resolved = resolvePath(statePath);
  await mkdir(dirname(resolved), { recursive: true });

  let state: { totalRuns: number; lastReport?: ConsolidationReport } = { totalRuns: 0 };
  try {
    const raw = await readFile(resolved, "utf-8");
    state = JSON.parse(raw) as typeof state;
  } catch {
    // first run, start fresh
  }

  state.totalRuns = (state.totalRuns ?? 0) + 1;
  state.lastReport = report;

  await writeFile(resolved, JSON.stringify(state, null, 2), "utf-8");
}
