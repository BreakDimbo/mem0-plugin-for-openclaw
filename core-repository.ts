import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

import type { CoreMemoryRecord, CoreMemoryTier, MemoryScope } from "./types.js";
import { genericConceptBoost, tokenizeSemanticQuery, trigramSimilarity } from "./metadata.js";
import { sanitizeCoreValue, shouldStoreCoreMemory } from "./security.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

type StoredCoreRecord = {
  id: string;
  category: string;
  key: string;
  value: string;
  importance?: number;
  tier?: CoreMemoryTier;
  source?: string;
  metadata?: Record<string, unknown>;
  scope: MemoryScope;
  createdAt: number;
  updatedAt: number;
  touchedAt?: number;
  expiresAt?: number;
};

type CoreStoreFile = {
  version: 1;
  items: StoredCoreRecord[];
};

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、“”"'`·:：；;（）()【】\[\]\-]/g, "");
}

function scoreTextMatch(query: string, key: string, value: string): number {
  const q = normalizeSearchText(query);
  if (!q) return 0;
  const hay = normalizeSearchText(`${key} ${value}`);
  if (hay.includes(q)) return 1;

  const qWords = tokenizeSemanticQuery(query).filter((token) => token.trim().length >= 2);
  if (qWords.length === 0) return genericConceptBoost(query, value);

  let hits = 0;
  for (const w of qWords) {
    if (hay.includes(normalizeSearchText(w))) hits += 1;
  }
  const lexical = hits / qWords.length;
  return lexical + genericConceptBoost(query, value);
}

function mapCategoryToken(token: string): string {
  switch (token) {
    case "identity":
    case "profile":
    case "person":
    case "bio":
      return "identity";
    case "preference":
    case "preferences":
      return "preferences";
    case "goal":
    case "goals":
      return "goals";
    case "constraint":
    case "constraints":
    case "team":
    case "stack":
      return "constraints";
    case "relationship":
    case "relationships":
      return "relationships";
    default:
      return "general";
  }
}

function inferCategoryFromKey(key: string): string {
  return mapCategoryToken(key.split(".")[0]?.trim().toLowerCase() ?? "");
}

export function normalizeCoreCategory(category: string | undefined, key: string): string {
  const normalized = (category ?? "").trim().toLowerCase();
  if (!normalized) return inferCategoryFromKey(key);
  return mapCategoryToken(normalized);
}

export function inferTierFromCategory(category: string): CoreMemoryTier {
  switch (category) {
    case "identity":
    case "preferences":
    case "goals":
    case "relationships":
    case "constraints":
      return "profile";
    case "technical":
    case "architecture":
    case "decision":
    case "benchmark":
      return "technical";
    default:
      return "general";
  }
}

function scopeMatches(scope: MemoryScope, record: StoredCoreRecord): boolean {
  if (record.scope.userId !== scope.userId || record.scope.agentId !== scope.agentId) return false;
  // Enforce tenantId isolation when present on either side
  if (scope.tenantId || record.scope.tenantId) {
    if (scope.tenantId !== record.scope.tenantId) return false;
  }
  return true;
}

function cloneRecord(record: StoredCoreRecord): CoreMemoryRecord {
  return {
    id: record.id,
    category: record.category,
    key: record.key,
    value: record.value,
    importance: record.importance,
    tier: record.tier ?? inferTierFromCategory(record.category),
    source: record.source,
    metadata: record.metadata,
    scope: { ...record.scope },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    touchedAt: record.touchedAt,
    expiresAt: record.expiresAt,
  };
}

export class CoreMemoryRepository {
  private readonly persistPath: string;
  private readonly logger: Logger;
  private readonly maxItemChars: number;
  private loadPromise: Promise<CoreStoreFile> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private state: CoreStoreFile | null = null;

  constructor(persistPath: string, logger: Logger, maxItemChars: number) {
    this.persistPath = persistPath.replace(/^~/, homedir());
    this.logger = logger;
    this.maxItemChars = maxItemChars;
  }

  private get filePath(): string {
    return this.persistPath ? `${this.persistPath}/core-memory.json` : "";
  }

  private async ensureLoaded(): Promise<CoreStoreFile> {
    if (this.state) return this.state;
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk();
    }
    this.state = await this.loadPromise;
    this.loadPromise = null;
    return this.state;
  }

  private async loadFromDisk(): Promise<CoreStoreFile> {
    if (!this.filePath) return { version: 1, items: [] };
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<CoreStoreFile>;
      if (parsed && Array.isArray(parsed.items)) {
        const now = Date.now();
        // Validate schema, drop expired (TTL) items
        const valid = parsed.items.filter((item): item is StoredCoreRecord =>
          !!item && typeof item === "object" &&
          typeof (item as Record<string, unknown>).id === "string" &&
          typeof (item as Record<string, unknown>).key === "string" &&
          typeof (item as Record<string, unknown>).value === "string" &&
          typeof (item as Record<string, unknown>).scope === "object" && !!(item as Record<string, unknown>).scope &&
          (!(item as StoredCoreRecord).expiresAt || (item as StoredCoreRecord).expiresAt! > now),
        );
        // Deduplicate: per (userId, agentId, tenantId, key) keep newest by updatedAt
        const seen = new Map<string, StoredCoreRecord>();
        for (const item of valid) {
          const dedupeKey = `${item.scope.userId}\0${item.scope.agentId}\0${item.scope.tenantId ?? ""}\0${item.key}`;
          const existing = seen.get(dedupeKey);
          if (!existing || (item.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
            seen.set(dedupeKey, item);
          }
        }
        return { version: 1, items: Array.from(seen.values()) };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn(`core-repo: load failed: ${String(err)}`);
      }
    }
    return { version: 1, items: [] };
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    const state = await this.ensureLoaded();
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(this.persistPath, { recursive: true });
      await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf-8");
    }).catch((err) => {
      this.logger.warn(`core-repo: persist failed: ${String(err)}`);
    });
    await this.writeQueue;
  }

  private async listScopeRecords(scope: MemoryScope): Promise<StoredCoreRecord[]> {
    const state = await this.ensureLoaded();
    return state.items.filter((item) => scopeMatches(scope, item));
  }

  async list(scope: MemoryScope, opts?: { query?: string; limit?: number; tiers?: CoreMemoryTier[] }): Promise<CoreMemoryRecord[]> {
    try {
      const now = Date.now();
      let records = (await this.listScopeRecords(scope))
        .filter((r) => !r.expiresAt || r.expiresAt > now)
        .map(cloneRecord);
      const totalBeforeLimit = records.length;

      // Filter by tier if specified
      if (opts?.tiers && opts.tiers.length > 0) {
        records = records.filter((r) => opts.tiers!.includes(r.tier ?? inferTierFromCategory(r.category ?? "general")));
      }

      if (opts?.query) {
        records = records.map((record) => ({
          ...record,
          score: record.score ?? scoreTextMatch(opts.query!, record.key, record.value),
        }));
      }

      records.sort((a, b) => {
        const scoreA = a.score ?? 0;
        const scoreB = b.score ?? 0;
        if (scoreA !== scoreB) return scoreB - scoreA;
        const impA = a.importance ?? (a.metadata?.importance as number | undefined) ?? 5;
        const impB = b.importance ?? (b.metadata?.importance as number | undefined) ?? 5;
        if (impA !== impB) return impB - impA;
        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      });

      const limit = opts?.limit ?? records.length;
      records = records.slice(0, limit);
      this.logger.info(`core-repo: list agent=${scope.agentId} total=${totalBeforeLimit} returned=${records.length} limit=${limit}`);
      return records;
    } catch (err) {
      this.logger.warn(`core-repo: list failed: ${String(err)}`);
      return [];
    }
  }

  async upsert(
    scope: MemoryScope,
    payload: {
      category?: string;
      key: string;
      value: string;
      importance?: number;
      source?: string;
      validUntil?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const key = payload.key.trim().toLowerCase();
    const value = sanitizeCoreValue(payload.value, this.maxItemChars);
    if (!shouldStoreCoreMemory(key, value, this.maxItemChars)) return false;

    const expiresAt = payload.validUntil ? new Date(payload.validUntil).getTime() : undefined;
    if (expiresAt !== undefined && (isNaN(expiresAt) || expiresAt <= Date.now())) {
      this.logger.warn(`core-repo: upsert rejected — validUntil is invalid or already expired: key=${key}`);
      return false;
    }

    try {
      const state = await this.ensureLoaded();
      const category = normalizeCoreCategory(payload.category, key);
      const tier = inferTierFromCategory(category);
      const now = Date.now();
      const existing = state.items.find((item) => scopeMatches(scope, item) && item.category === category && item.key === key);
      if (existing) {
        existing.value = value;
        existing.importance = payload.importance;
        existing.tier = tier;
        existing.source = payload.source ?? existing.source ?? "memory-mem0";
        existing.metadata = payload.metadata ? { ...payload.metadata } : existing.metadata;
        existing.updatedAt = now;
        existing.expiresAt = expiresAt;
      } else {
        state.items.push({
          id: randomUUID(),
          category,
          key,
          value,
          importance: payload.importance,
          tier,
          source: payload.source ?? "memory-mem0",
          metadata: payload.metadata ? { ...payload.metadata } : undefined,
          scope: { ...scope },
          createdAt: now,
          updatedAt: now,
          expiresAt,
        });
      }
      await this.persist();
      return true;
    } catch (err) {
      this.logger.warn(`core-repo: upsert failed: ${String(err)}`);
      return false;
    }
  }

  async upsertMany(
    scope: MemoryScope,
    items: Array<{
      category: string;
      key: string;
      value: string;
      importance?: number;
      provenance?: string;
      validUntil?: string;
    }>,
  ): Promise<boolean> {
    const now = Date.now();
    const normalizedItems = items
      .map((item) => {
        const key = item.key.trim().toLowerCase();
        const value = sanitizeCoreValue(item.value, this.maxItemChars);
        const category = normalizeCoreCategory(item.category, key);
        const expiresAt = item.validUntil ? new Date(item.validUntil).getTime() : undefined;
        return {
          category,
          key,
          value,
          importance: item.importance,
          tier: inferTierFromCategory(category) as CoreMemoryTier,
          source: item.provenance ?? "memory-mem0",
          expiresAt,
        };
      })
      .filter((item) =>
        shouldStoreCoreMemory(item.key, item.value, this.maxItemChars) &&
        (item.expiresAt === undefined || (!isNaN(item.expiresAt) && item.expiresAt > now)),
      );

    if (normalizedItems.length === 0) return false;

    try {
      const state = await this.ensureLoaded();
      for (const item of normalizedItems) {
        const existing = state.items.find((record) => scopeMatches(scope, record) && record.category === item.category && record.key === item.key);
        if (existing) {
          existing.value = item.value;
          existing.importance = item.importance;
          existing.tier = item.tier;
          existing.source = item.source;
          existing.updatedAt = now;
          existing.expiresAt = item.expiresAt;
        } else {
          state.items.push({
            id: randomUUID(),
            category: item.category,
            key: item.key,
            value: item.value,
            importance: item.importance,
            tier: item.tier,
            source: item.source,
            scope: { ...scope },
            createdAt: now,
            updatedAt: now,
            expiresAt: item.expiresAt,
          });
        }
      }
      await this.persist();
      return true;
    } catch (err) {
      this.logger.warn(`core-repo: upsertMany failed: ${String(err)}`);
      return false;
    }
  }

  async delete(scope: MemoryScope, ref: { category?: string; key?: string; id?: string }): Promise<boolean> {
    let category = ref.category?.trim();
    let key = ref.key?.trim().toLowerCase();
    if (!category && key) category = inferCategoryFromKey(key);

    if ((!category || !key) && ref.id) {
      const records = await this.list(scope, { limit: 200 });
      const found = records.find((record) => record.id === ref.id);
      if (found) {
        category = found.category;
        key = found.key.trim().toLowerCase();
      }
    }
    if (!category || !key) return false;

    try {
      const state = await this.ensureLoaded();
      const before = state.items.length;
      state.items = state.items.filter((item) => !(scopeMatches(scope, item) && item.category === category && item.key === key));
      if (state.items.length === before) return false;
      await this.persist();
      return true;
    } catch (err) {
      this.logger.warn(`core-repo: delete failed: ${String(err)}`);
      return false;
    }
  }

  async touch(
    scope: MemoryScope,
    ref: { ids?: string[]; id?: string; kind?: "access" | "injected"; category?: string; key?: string },
  ): Promise<boolean> {
    let ids = (ref.ids && ref.ids.length > 0 ? ref.ids : ref.id ? [ref.id] : [])
      .map((id) => id.trim())
      .filter(Boolean);

    if (ids.length === 0 && ref.key) {
      const records = await this.list(scope, { limit: 200 });
      const targetKey = ref.key.trim().toLowerCase();
      const targetCategory = ref.category?.trim();
      ids = records
        .filter((record) => record.key.trim().toLowerCase() === targetKey && (!targetCategory || record.category === targetCategory))
        .map((record) => record.id);
    }

    if (ids.length === 0) return false;

    try {
      const state = await this.ensureLoaded();
      const now = Date.now();
      let touched = 0;
      for (const item of state.items) {
        if (scopeMatches(scope, item) && ids.includes(item.id) && (!item.expiresAt || item.expiresAt > now)) {
          item.touchedAt = now;
          item.updatedAt = Math.max(item.updatedAt, now);
          touched += 1;
        }
      }
      if (touched === 0) return false;
      await this.persist();
      return true;
    } catch (err) {
      this.logger.warn(`core-repo: touch failed: ${String(err)}`);
      return false;
    }
  }

  async consolidate(
    scope: MemoryScope,
    opts?: { dryRun?: boolean; similarityThreshold?: number },
  ): Promise<{ merged: number; deleted: number; unchanged: number }> {
    const threshold = opts?.similarityThreshold ?? 0.85;
    const dryRun = opts?.dryRun ?? false;
    let deleted = 0;
    let merged = 0;

    try {
      const state = await this.ensureLoaded();
      const now = Date.now();
      const scopeRecords = state.items.filter((item) => scopeMatches(scope, item) && (!item.expiresAt || item.expiresAt > now));

      // Group by (category, key) for exact-key dedup
      const byKey = new Map<string, StoredCoreRecord[]>();
      for (const record of scopeRecords) {
        const groupKey = `${record.category}::${record.key}`;
        const group = byKey.get(groupKey);
        if (group) {
          group.push(record);
        } else {
          byKey.set(groupKey, [record]);
        }
      }

      const toDelete = new Set<string>(); // record ids to remove

      // Step 1: Exact-key dedup — keep latest updatedAt per (category, key)
      // Tie-break by createdAt for deterministic behavior when updatedAt is identical (batch upserts).
      for (const [, group] of byKey) {
        if (group.length <= 1) continue;
        group.sort((a, b) => {
          const byUpdated = b.updatedAt - a.updatedAt;
          return byUpdated !== 0 ? byUpdated : b.createdAt - a.createdAt;
        });
        for (let i = 1; i < group.length; i++) {
          toDelete.add(group[i].id);
          deleted++;
        }
      }

      // Step 2: Value dedup within category — detect near-identical values with different keys
      const byCategory = new Map<string, StoredCoreRecord[]>();
      for (const record of scopeRecords) {
        if (toDelete.has(record.id)) continue; // already marked for deletion
        const group = byCategory.get(record.category);
        if (group) {
          group.push(record);
        } else {
          byCategory.set(record.category, [record]);
        }
      }

      for (const [, categoryRecords] of byCategory) {
        if (categoryRecords.length <= 1) continue;
        for (let i = 0; i < categoryRecords.length; i++) {
          if (toDelete.has(categoryRecords[i].id)) continue;
          for (let j = i + 1; j < categoryRecords.length; j++) {
            if (toDelete.has(categoryRecords[j].id)) continue;
            const sim = trigramSimilarity(categoryRecords[i].value, categoryRecords[j].value);
            if (sim >= threshold) {
              const impI = categoryRecords[i].importance ?? 5;
              const impJ = categoryRecords[j].importance ?? 5;
              const loser =
                impI > impJ ? categoryRecords[j] :
                impJ > impI ? categoryRecords[i] :
                categoryRecords[i].updatedAt >= categoryRecords[j].updatedAt ? categoryRecords[j] : categoryRecords[i];
              toDelete.add(loser.id);
              merged++;
            }
          }
        }
      }

      const unchanged = scopeRecords.length - deleted - merged;

      if (toDelete.size > 0 && !dryRun) {
        state.items = state.items.filter((item) => !toDelete.has(item.id));
        await this.persist();
      }

      this.logger.info(
        `core-repo: consolidate scope=${scope.agentId} deleted=${deleted} merged=${merged} unchanged=${unchanged}${dryRun ? " (dry-run)" : ""}`,
      );

      return { merged, deleted, unchanged };
    } catch (err) {
      this.logger.warn(`core-repo: consolidate failed: ${String(err)}`);
      return { merged: 0, deleted: 0, unchanged: 0 };
    }
  }
}
