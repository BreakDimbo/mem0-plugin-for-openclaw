import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { DreamingConfig } from "../types.js";
import type { ShortTermRecallEntry } from "./types.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

type SignalStoreFile = {
  version: 1;
  updatedAt: string;
  entries: ShortTermRecallEntry[];
};

export class RecallSignalStore {
  private readonly signalPath: string;
  private readonly config: Pick<DreamingConfig, "maxSignalEntries" | "maxQueryHashes" | "maxRecallDays" | "maxConceptTags" | "timezone">;
  private readonly logger: Logger;
  private entries: Map<string, ShortTermRecallEntry> = new Map();
  private flushPromise: Promise<void> | null = null;

  constructor(
    signalPath: string,
    config: Pick<DreamingConfig, "maxSignalEntries" | "maxQueryHashes" | "maxRecallDays" | "maxConceptTags" | "timezone">,
    logger: Logger = { info: () => {}, warn: console.warn },
  ) {
    this.signalPath = signalPath.replace(/^~/, homedir());
    this.config = config;
    this.logger = logger;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.signalPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<SignalStoreFile>;
      if (parsed.version !== 1) {
        this.logger.warn(`signal-store: version mismatch (${parsed.version}), resetting store`);
        this.entries = new Map();
        return;
      }
      if (!Array.isArray(parsed.entries)) {
        this.logger.warn("signal-store: invalid entries array, resetting store");
        this.entries = new Map();
        return;
      }
      const validated = parsed.entries.filter((e) => {
        if (!e || typeof e !== "object") return false;
        if (typeof e.key !== "string" || !e.key) return false;
        if (!Array.isArray(e.queryHashes)) return false;
        if (!Array.isArray(e.recallDays)) return false;
        if (typeof e.recallCount !== "number" || !Number.isFinite(e.recallCount)) return false;
        return true;
      }) as ShortTermRecallEntry[];
      this.entries = new Map(validated.map((e) => [e.key, e]));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.entries = new Map();
        return;
      }
      this.logger.warn(`signal-store: load failed — ${String(err)}`);
      this.entries = new Map();
    }
  }

  async flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }

    this.flushPromise = (async () => {
      // 1. Load latest state from disk and merge into memory
      try {
        const raw = await readFile(this.signalPath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<SignalStoreFile>;
        if (parsed.version === 1 && Array.isArray(parsed.entries)) {
          for (const diskEntry of parsed.entries) {
            if (!diskEntry || typeof diskEntry !== "object") continue;
            if (typeof diskEntry.key !== "string" || !diskEntry.key) continue;
            if (!Array.isArray(diskEntry.queryHashes)) continue;
            if (!Array.isArray(diskEntry.recallDays)) continue;
            if (typeof diskEntry.recallCount !== "number" || !Number.isFinite(diskEntry.recallCount)) continue;

            const memEntry = this.entries.get(diskEntry.key);
            if (!memEntry) {
              this.entries.set(diskEntry.key, diskEntry);
            } else {
              // Merge disk entry into memory entry
              memEntry.recallCount += diskEntry.recallCount;
              memEntry.totalScore += diskEntry.totalScore;
              memEntry.maxScore = Math.max(memEntry.maxScore, diskEntry.maxScore);
              memEntry.lastRecalledAt = Math.max(memEntry.lastRecalledAt, diskEntry.lastRecalledAt);
              memEntry.firstRecalledAt = Math.min(memEntry.firstRecalledAt, diskEntry.firstRecalledAt);

              for (const qh of diskEntry.queryHashes) {
                if (!memEntry.queryHashes.includes(qh)) {
                  memEntry.queryHashes.push(qh);
                }
              }
              if (memEntry.queryHashes.length > this.config.maxQueryHashes) {
                memEntry.queryHashes = memEntry.queryHashes.slice(-this.config.maxQueryHashes);
              }

              for (const rd of diskEntry.recallDays) {
                if (!memEntry.recallDays.includes(rd)) {
                  memEntry.recallDays.push(rd);
                }
              }
              if (memEntry.recallDays.length > this.config.maxRecallDays) {
                memEntry.recallDays = memEntry.recallDays.slice(-this.config.maxRecallDays);
              }

              for (const tag of diskEntry.conceptTags) {
                if (!memEntry.conceptTags.includes(tag)) {
                  memEntry.conceptTags.push(tag);
                }
              }
              if (memEntry.conceptTags.length > this.config.maxConceptTags) {
                memEntry.conceptTags = memEntry.conceptTags.slice(-this.config.maxConceptTags);
              }

              if (diskEntry.promotedAt !== undefined) {
                if (memEntry.promotedAt === undefined) {
                  memEntry.promotedAt = diskEntry.promotedAt;
                } else {
                  memEntry.promotedAt = Math.min(memEntry.promotedAt, diskEntry.promotedAt);
                }
              }
            }
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          this.logger.warn(`signal-store: flush-load failed — ${String(err)}`);
        }
        // ENOENT means file doesn't exist yet; proceed with in-memory entries only
      }

      // 2. Write merged state to disk
      const data: SignalStoreFile = {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: this.getAll(),
      };
      const tmpPath = `${this.signalPath}.tmp`;
      await mkdir(dirname(this.signalPath), { recursive: true });
      await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      await rename(tmpPath, this.signalPath);

      // 3. Clear in-memory entries to prevent double-counting on next flush
      this.entries.clear();
    })().catch((err) => {
      try {
        this.logger.warn(`signal-store: flush failed — ${String(err)}`);
      } catch {
        // ignore logger failure
      }
      throw err;
    }).finally(() => {
      this.flushPromise = null;
    });

    return this.flushPromise;
  }

  recordRecall(params: {
    key: string;
    layer: "core" | "free-text";
    snippet: string;
    queryHash: string;
    relevanceScore: number;
    conceptTags: string[];
  }): void {
    const now = Date.now();
    const sanitizedScore = Number.isFinite(params.relevanceScore)
      ? Math.max(0, Math.min(1, params.relevanceScore))
      : 0;

    const existing = this.entries.get(params.key);
    if (existing) {
      existing.recallCount += 1;
      existing.totalScore += sanitizedScore;
      existing.maxScore = Math.max(existing.maxScore, sanitizedScore);
      existing.lastRecalledAt = now;

      if (!existing.queryHashes.includes(params.queryHash)) {
        existing.queryHashes.push(params.queryHash);
        if (existing.queryHashes.length > this.config.maxQueryHashes) {
          existing.queryHashes.shift();
        }
      }

      const today = this.getToday();
      if (!existing.recallDays.includes(today)) {
        existing.recallDays.push(today);
        if (existing.recallDays.length > this.config.maxRecallDays) {
          existing.recallDays.shift();
        }
      }

      const tagSet = new Set([...existing.conceptTags, ...params.conceptTags]);
      existing.conceptTags = Array.from(tagSet).slice(0, this.config.maxConceptTags ?? 20);
    } else {
      const queryHashes = [] as string[];
      queryHashes.push(params.queryHash);
      const recallDays = [] as string[];
      const today = this.getToday();
      recallDays.push(today);

      const newEntry: ShortTermRecallEntry = {
        key: params.key,
        layer: params.layer,
        snippet: params.snippet,
        recallCount: 1,
        totalScore: sanitizedScore,
        maxScore: sanitizedScore,
        firstRecalledAt: now,
        lastRecalledAt: now,
        queryHashes,
        recallDays,
        conceptTags: params.conceptTags.slice(0, this.config.maxConceptTags ?? 20),
      };
      this.entries.set(params.key, newEntry);
    }
  }

  getAll(): ShortTermRecallEntry[] {
    return Array.from(this.entries.values());
  }

  get(key: string): ShortTermRecallEntry | undefined {
    return this.entries.get(key);
  }

  markPromoted(key: string): void {
    const entry = this.entries.get(key);
    if (entry && entry.promotedAt === undefined) {
      entry.promotedAt = Date.now();
    }
  }

  prune(): void {
    if (this.entries.size <= this.config.maxSignalEntries) {
      return;
    }

    let needToRemove = this.entries.size - this.config.maxSignalEntries;

    // Phase 1: remove promoted entries sorted by promotedAt ASC
    if (needToRemove > 0) {
      const promoted = Array.from(this.entries.values())
        .filter((e) => e.promotedAt !== undefined)
        .sort((a, b) => (a.promotedAt ?? 0) - (b.promotedAt ?? 0));

      for (const entry of promoted) {
        if (needToRemove <= 0) break;
        this.entries.delete(entry.key);
        needToRemove--;
      }
    }

    // Phase 2: remove remaining by lastRecalledAt ASC
    if (needToRemove > 0) {
      const remaining = Array.from(this.entries.values()).sort(
        (a, b) => a.lastRecalledAt - b.lastRecalledAt,
      );
      for (const entry of remaining) {
        if (needToRemove <= 0) break;
        this.entries.delete(entry.key);
        needToRemove--;
      }
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private getToday(): string {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: this.config.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = dtf.formatToParts(new Date());
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    return `${year}-${month}-${day}`;
  }
}
