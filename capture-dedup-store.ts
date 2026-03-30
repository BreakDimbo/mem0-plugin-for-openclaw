// ============================================================================
// CaptureDedupStore: persistent cross-session capture deduplication
// Stores content hashes per scope to prevent re-capturing the same text
// across process restarts.
// ============================================================================

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";

export class CaptureDedupStore {
  private cache = new Map<string, string[]>();
  private loadPromise: Promise<void> | null = null;
  private readonly filePath: string;

  constructor(
    persistPath: string,
    private readonly maxPerScope = 200,
  ) {
    this.filePath = persistPath.replace(/^~/, homedir()) + "/capture-dedup.json";
  }

  static hashText(text: string): string {
    return createHash("sha256")
      .update(text.trim().toLowerCase())
      .digest("hex")
      .slice(0, 16);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const raw = await readFile(this.filePath, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
            if (Array.isArray(val) && val.every((v) => typeof v === "string")) {
              this.cache.set(key, val as string[]);
            }
          }
        }
      } catch {
        // File not found or corrupted — start fresh
      }
    })();
    return this.loadPromise;
  }

  private async saveToDisk(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const obj: Record<string, string[]> = {};
      for (const [key, val] of this.cache.entries()) {
        obj[key] = val;
      }
      await writeFile(this.filePath, JSON.stringify(obj), "utf-8");
    } catch {
      // Tolerate save failures — dedup is best-effort
    }
  }

  async has(scopeKey: string, hash: string): Promise<boolean> {
    await this.ensureLoaded();
    return (this.cache.get(scopeKey) ?? []).includes(hash);
  }

  async add(scopeKey: string, hash: string): Promise<void> {
    await this.ensureLoaded();
    const existing = this.cache.get(scopeKey) ?? [];
    if (existing.includes(hash)) return;
    existing.push(hash);
    if (existing.length > this.maxPerScope) {
      existing.splice(0, existing.length - this.maxPerScope);
    }
    this.cache.set(scopeKey, existing);
    await this.saveToDisk();
  }
}
