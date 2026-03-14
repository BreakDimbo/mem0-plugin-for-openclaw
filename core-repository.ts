import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

import type { CoreMemoryRecord, MemoryScope } from "./types.js";
import { genericConceptBoost, tokenizeSemanticQuery } from "./metadata.js";
import { sanitizeCoreValue, shouldStoreCoreMemory } from "./security.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

type StoredCoreRecord = {
  id: string;
  category: string;
  key: string;
  value: string;
  importance?: number;
  source?: string;
  metadata?: Record<string, unknown>;
  scope: MemoryScope;
  createdAt: number;
  updatedAt: number;
  touchedAt?: number;
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

function inferCategoryFromKey(key: string): string {
  const head = key.split(".")[0]?.trim().toLowerCase();
  switch (head) {
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
      return "constraints";
    case "relationship":
    case "relationships":
      return "relationships";
    default:
      return "general";
  }
}

export function normalizeCoreCategory(category: string | undefined, key: string): string {
  const normalized = (category ?? "").trim().toLowerCase();
  if (!normalized) return inferCategoryFromKey(key);
  switch (normalized) {
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

function scopeMatches(scope: MemoryScope, record: StoredCoreRecord): boolean {
  return record.scope.userId === scope.userId && record.scope.agentId === scope.agentId;
}

function cloneRecord(record: StoredCoreRecord): CoreMemoryRecord {
  return {
    id: record.id,
    category: record.category,
    key: record.key,
    value: record.value,
    importance: record.importance,
    source: record.source,
    metadata: record.metadata,
    scope: { ...record.scope },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    touchedAt: record.touchedAt,
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
        return {
          version: 1,
          items: parsed.items.filter((item): item is StoredCoreRecord => !!item && typeof item === "object"),
        };
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

  async list(scope: MemoryScope, opts?: { query?: string; limit?: number }): Promise<CoreMemoryRecord[]> {
    try {
      let records = (await this.listScopeRecords(scope)).map(cloneRecord);
      const totalBeforeLimit = records.length;

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

    try {
      const state = await this.ensureLoaded();
      const category = normalizeCoreCategory(payload.category, key);
      const now = Date.now();
      const existing = state.items.find((item) => scopeMatches(scope, item) && item.category === category && item.key === key);
      if (existing) {
        existing.value = value;
        existing.importance = payload.importance;
        existing.source = payload.source ?? existing.source ?? "memory-mem0";
        existing.metadata = payload.metadata ? { ...payload.metadata } : existing.metadata;
        existing.updatedAt = now;
      } else {
        state.items.push({
          id: randomUUID(),
          category,
          key,
          value,
          importance: payload.importance,
          source: payload.source ?? "memory-mem0",
          metadata: payload.metadata ? { ...payload.metadata } : undefined,
          scope: { ...scope },
          createdAt: now,
          updatedAt: now,
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
    const normalizedItems = items
      .map((item) => {
        const key = item.key.trim().toLowerCase();
        const value = sanitizeCoreValue(item.value, this.maxItemChars);
        return {
          category: normalizeCoreCategory(item.category, key),
          key,
          value,
          importance: item.importance,
          source: item.provenance ?? "memory-mem0",
        };
      })
      .filter((item) => shouldStoreCoreMemory(item.key, item.value, this.maxItemChars));

    if (normalizedItems.length === 0) return false;

    try {
      const state = await this.ensureLoaded();
      const now = Date.now();
      for (const item of normalizedItems) {
        const existing = state.items.find((record) => scopeMatches(scope, record) && record.category === item.category && record.key === item.key);
        if (existing) {
          existing.value = item.value;
          existing.importance = item.importance;
          existing.source = item.source;
          existing.updatedAt = now;
        } else {
          state.items.push({
            id: randomUUID(),
            category: item.category,
            key: item.key,
            value: item.value,
            importance: item.importance,
            source: item.source,
            scope: { ...scope },
            createdAt: now,
            updatedAt: now,
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
        if (scopeMatches(scope, item) && ids.includes(item.id)) {
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
}
