import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { PhaseSignalEntry } from "./types.js";

type PhaseStoreFile = {
  version: 1;
  updatedAt: string;
  entries: Record<string, PhaseSignalEntry>;
};

export class PhaseSignalStore {
  private readonly signalPath: string;
  private entries: Map<string, PhaseSignalEntry> = new Map();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(signalPath: string) {
    this.signalPath = signalPath.replace(/^~/, homedir());
  }

  get size(): number {
    return this.entries.size;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.signalPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PhaseStoreFile>;
      if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        this.entries = new Map();
        for (const [key, entry] of Object.entries(parsed.entries)) {
          if (entry && typeof entry === "object" && typeof entry.key === "string") {
            this.entries.set(key, {
              key: entry.key,
              lightHits: typeof entry.lightHits === "number" ? entry.lightHits : 0,
              remHits: typeof entry.remHits === "number" ? entry.remHits : 0,
              lastLightAt: typeof entry.lastLightAt === "number" ? entry.lastLightAt : undefined,
              lastRemAt: typeof entry.lastRemAt === "number" ? entry.lastRemAt : undefined,
            });
          }
        }
      } else {
        console.warn(`phase-signal-store: unexpected file version or format at ${this.signalPath}, initializing empty store`);
        this.entries = new Map();
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.entries = new Map();
      } else {
        console.warn(`phase-signal-store: load failed: ${String(err)}`);
        this.entries = new Map();
      }
    }
  }

  async flush(): Promise<void> {
    const op = (async () => {
      // 1. Load latest state from disk and merge into memory
      try {
        const raw = await readFile(this.signalPath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<PhaseStoreFile>;
        if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
          for (const [key, diskEntry] of Object.entries(parsed.entries)) {
            if (!diskEntry || typeof diskEntry !== "object") continue;
            if (typeof diskEntry.key !== "string") continue;
            if (typeof diskEntry.lightHits !== "number" || !Number.isFinite(diskEntry.lightHits)) continue;
            if (typeof diskEntry.remHits !== "number" || !Number.isFinite(diskEntry.remHits)) continue;

            const memEntry = this.entries.get(key);
            if (!memEntry) {
              this.entries.set(key, {
                key: diskEntry.key,
                lightHits: diskEntry.lightHits,
                remHits: diskEntry.remHits,
                lastLightAt: typeof diskEntry.lastLightAt === "number" ? diskEntry.lastLightAt : undefined,
                lastRemAt: typeof diskEntry.lastRemAt === "number" ? diskEntry.lastRemAt : undefined,
              });
            } else {
              memEntry.lightHits += diskEntry.lightHits;
              memEntry.remHits += diskEntry.remHits;
              if (typeof diskEntry.lastLightAt === "number") {
                memEntry.lastLightAt = Math.max(memEntry.lastLightAt ?? 0, diskEntry.lastLightAt);
              }
              if (typeof diskEntry.lastRemAt === "number") {
                memEntry.lastRemAt = Math.max(memEntry.lastRemAt ?? 0, diskEntry.lastRemAt);
              }
            }
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          console.warn(`phase-signal-store: flush-load failed — ${String(err)}`);
        }
        // ENOENT means file doesn't exist yet; proceed with in-memory entries only
      }

      // 2. Write merged state to disk
      const payload: PhaseStoreFile = {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: Object.fromEntries(this.entries),
      };
      const tmpPath = `${this.signalPath}.tmp`;
      await mkdir(dirname(this.signalPath), { recursive: true });
      await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
      await rename(tmpPath, this.signalPath);

      // 3. Clear in-memory entries to prevent double-counting on next flush
      this.entries.clear();
    })();
    this.writeQueue = this.writeQueue.then(() => op).catch(() => {});
    await op;
  }

  recordLightHit(key: string): void {
    const existing = this.entries.get(key);
    if (existing) {
      existing.lightHits += 1;
      existing.lastLightAt = Date.now();
    } else {
      this.entries.set(key, {
        key,
        lightHits: 1,
        remHits: 0,
        lastLightAt: Date.now(),
      });
    }
  }

  recordRemHit(key: string): void {
    const existing = this.entries.get(key);
    if (existing) {
      existing.remHits += 1;
      existing.lastRemAt = Date.now();
    } else {
      this.entries.set(key, {
        key,
        lightHits: 0,
        remHits: 1,
        lastRemAt: Date.now(),
      });
    }
  }

  get(key: string): PhaseSignalEntry | undefined {
    return this.entries.get(key);
  }

  getAll(): Map<string, PhaseSignalEntry> {
    return new Map(this.entries);
  }

  prune(activeKeys: Set<string>): number {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (!activeKeys.has(key)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
