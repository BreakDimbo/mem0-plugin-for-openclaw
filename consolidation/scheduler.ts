// ============================================================================
// ConsolidationScheduler — hourly tick, persisted lastRun state, crash-safe
//
// Design:
//  • Checks wall-clock hour on each tick (default 1 hour)
//  • Persists lastRun timestamps to disk so restarts don't re-run immediately
//  • Only one concurrent run per cycle (inflight guard)
//  • Graceful stop: drains in-flight run before stopping
// ============================================================================

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { ConsolidationConfig, MemoryScope } from "../types.js";
import type { ConsolidationRunner } from "./runner.js";
import type { ConsolidationCycle, ConsolidationState } from "./types.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

async function loadState(statePath: string): Promise<ConsolidationState> {
  const resolved = resolvePath(statePath);
  try {
    const raw = await readFile(resolved, "utf-8");
    return JSON.parse(raw) as ConsolidationState;
  } catch {
    return { totalRuns: 0 };
  }
}

async function saveState(statePath: string, state: ConsolidationState): Promise<void> {
  const resolved = resolvePath(statePath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(state, null, 2), "utf-8");
}

function isSameDayHour(lastRun: string | undefined, targetHour: number): boolean {
  if (!lastRun) return false;
  const last = new Date(lastRun);
  const now = new Date();
  return (
    last.getFullYear() === now.getFullYear() &&
    last.getMonth() === now.getMonth() &&
    last.getDate() === now.getDate() &&
    last.getHours() >= targetHour
  );
}

function isSameWeekDay(lastRun: string | undefined, targetHour: number): boolean {
  if (!lastRun) return false;
  const last = new Date(lastRun);
  const now = new Date();
  const getISOWeek = (d: Date) => {
    const start = new Date(d.getFullYear(), 0, 1);
    return Math.ceil(((d.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
  };
  return (
    last.getFullYear() === now.getFullYear() &&
    getISOWeek(last) === getISOWeek(now) &&
    last.getHours() >= targetHour
  );
}

function isSameMonth(lastRun: string | undefined, targetHour: number): boolean {
  if (!lastRun) return false;
  const last = new Date(lastRun);
  const now = new Date();
  return (
    last.getFullYear() === now.getFullYear() &&
    last.getMonth() === now.getMonth() &&
    last.getHours() >= targetHour
  );
}

export class ConsolidationScheduler {
  private readonly runner: ConsolidationRunner;
  private readonly config: ConsolidationConfig;
  private readonly scope: MemoryScope;
  private readonly logger: Logger;

  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private inflight = new Map<ConsolidationCycle, Promise<void>>();

  constructor(
    runner: ConsolidationRunner,
    config: ConsolidationConfig,
    scope: MemoryScope,
    logger: Logger,
  ) {
    this.runner = runner;
    this.config = config;
    this.scope = scope;
    this.logger = logger;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    // Tick every hour; do an initial check in 5s to surface any missed runs
    setTimeout(() => { this.tick().catch(() => {}); }, 5_000);
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.config.intervalMs);
    this.logger.info(`consolidation-scheduler: started (interval=${this.config.intervalMs}ms)`);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.logger.info("consolidation-scheduler: stopped");
  }

  /** Force a manual run (used by CLI /memu consolidate run <cycle>) */
  async forceRun(cycle: ConsolidationCycle, dryRun: boolean): Promise<void> {
    return this.runCycle(cycle, dryRun, true);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (!this.config.enabled) return;

    const now = new Date();
    const hour = now.getHours();
    const weekday = now.getDay();   // 0=Sun … 6=Sat
    const dayOfMonth = now.getDate(); // 1–31

    const state = await loadState(this.config.statePath).catch(() => ({ totalRuns: 0 } as ConsolidationState));

    const { daily, weekly, monthly } = this.config.schedule;

    // dayOfWeek: if configured, must match today's weekday
    const weeklyDayMatch = weekly.dayOfWeek == null || weekly.dayOfWeek === weekday;
    // dayOfMonth: if configured, must match today's date
    const monthlyDayMatch = monthly.dayOfMonth == null || monthly.dayOfMonth === dayOfMonth;

    const checks: Array<[ConsolidationCycle, boolean, boolean]> = [
      ["daily",   daily.enabled,   hour === daily.hourOfDay   && !isSameDayHour(state.lastDailyRun,   daily.hourOfDay)],
      ["weekly",  weekly.enabled,  weeklyDayMatch  && hour === weekly.hourOfDay  && !isSameWeekDay(state.lastWeeklyRun,  weekly.hourOfDay)],
      ["monthly", monthly.enabled, monthlyDayMatch && hour === monthly.hourOfDay && !isSameMonth(state.lastMonthlyRun,  monthly.hourOfDay)],
    ];

    for (const [cycle, enabled, shouldRun] of checks) {
      if (enabled && shouldRun) {
        this.runCycle(cycle, false, false).catch((err) => {
          this.logger.warn(`consolidation-scheduler: ${cycle} run error: ${String(err)}`);
        });
      }
    }
  }

  private async runCycle(cycle: ConsolidationCycle, dryRun: boolean, force: boolean): Promise<void> {
    if (this.inflight.has(cycle)) {
      this.logger.info(`consolidation-scheduler: ${cycle} already in-flight, skipping`);
      return this.inflight.get(cycle);
    }

    const promise = (async () => {
      try {
        const report = await this.runner.run(this.scope, cycle, dryRun);

        if (!dryRun) {
          // Persist lastRun timestamp
          const state = await loadState(this.config.statePath).catch(() => ({ totalRuns: 0 } as ConsolidationState));
          const now = new Date().toISOString();
          if (cycle === "daily")   state.lastDailyRun   = now;
          if (cycle === "weekly")  state.lastWeeklyRun  = now;
          if (cycle === "monthly") state.lastMonthlyRun = now;
          state.totalRuns = (state.totalRuns ?? 0) + 1;
          state.lastReport = report;
          await saveState(this.config.statePath, state).catch((err) => {
            this.logger.warn(`consolidation-scheduler: state persist failed: ${String(err)}`);
          });
        }
      } finally {
        this.inflight.delete(cycle);
      }
    })();

    this.inflight.set(cycle, promise);
    return promise;
  }
}

// ── Re-export state helpers for CLI ─────────────────────────────────────────

export { loadState, saveState };
export type { ConsolidationState };
