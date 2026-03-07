// ============================================================================
// Generic LRU Cache with TTL
// Aligned with §13: scope-aware key, evict oldest 10%
// ============================================================================

import { createHash } from "node:crypto";

type CacheEntry<T> = {
  value: T;
  timestamp: number;
};

export class LRUCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  private _hits = 0;
  private _misses = 0;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /**
   * Build a cache key from scope + query + limit per §13:
   * `${scopeKey}:${query}:${limit}`
   */
  static buildCacheKey(query: string, scopeKey?: string, limit?: number): string {
    const parts = [scopeKey ?? "", query.trim().toLowerCase(), String(limit ?? "")];
    return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 16);
  }

  /** @deprecated Use buildCacheKey for scope-aware keys */
  static hashKey(input: string): string {
    return createHash("sha256").update(input.trim().toLowerCase()).digest("hex").slice(0, 16);
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.map.delete(key);
      this._misses++;
      return undefined;
    }

    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, entry);
    this._hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    this.map.delete(key);

    if (this.map.size >= this.maxSize) {
      // Evict oldest 10% per §13
      const evictCount = Math.max(1, Math.floor(this.maxSize * 0.1));
      const keys = this.map.keys();
      for (let i = 0; i < evictCount; i++) {
        const oldest = keys.next().value;
        if (oldest !== undefined) {
          this.map.delete(oldest);
        }
      }
    }

    this.map.set(key, { value, timestamp: Date.now() });
  }

  has(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  clear(): void {
    this.map.clear();
    this._hits = 0;
    this._misses = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get hits(): number {
    return this._hits;
  }

  get misses(): number {
    return this._misses;
  }

  get hitRate(): number {
    const total = this._hits + this._misses;
    return total === 0 ? 0 : this._hits / total;
  }
}
