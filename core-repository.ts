import type { MemUClient } from "./client.js";
import type { CoreMemoryRecord, MemoryScope } from "./types.js";
import { sanitizeCoreValue, shouldStoreCoreMemory } from "./security.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toTimestamp(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const ts = Date.parse(v);
    if (!Number.isNaN(ts)) return ts;
  }
  return undefined;
}

function scoreTextMatch(query: string, key: string, value: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const hay = `${key} ${value}`.toLowerCase();
  if (hay.includes(q)) return 1;
  const qWords = q.split(/\s+/).filter(Boolean);
  if (qWords.length === 0) return 0;
  let hits = 0;
  for (const w of qWords) {
    if (w.length < 2) continue;
    if (hay.includes(w)) hits++;
  }
  return hits / qWords.length;
}

function inferCategoryFromKey(key: string): string {
  const head = key.split(".")[0]?.trim().toLowerCase();
  return head || "general";
}

export class CoreMemoryRepository {
  private readonly client: MemUClient;
  private readonly logger: Logger;
  private readonly maxItemChars: number;

  constructor(client: MemUClient, logger: Logger, maxItemChars: number) {
    this.client = client;
    this.logger = logger;
    this.maxItemChars = maxItemChars;
  }

  private normalizeRecords(items: unknown, scope: MemoryScope): CoreMemoryRecord[] {
    const candidates = Array.isArray(items) ? items : [];
    const out: CoreMemoryRecord[] = [];
    for (const raw of candidates) {
      const obj = asRecord(raw);
      if (!obj) continue;

      const id = String(obj.id ?? obj.memory_id ?? obj.key ?? "");
      const key = String(obj.key ?? obj.name ?? obj.memory_key ?? "").trim();
      const valueRaw = String(obj.value ?? obj.text ?? obj.content ?? "").trim();
      if (!id || !key || !valueRaw) continue;

      const value = sanitizeCoreValue(valueRaw, this.maxItemChars);
      if (!shouldStoreCoreMemory(key, value, this.maxItemChars)) continue;

      out.push({
        id,
        category: typeof obj.category === "string" ? obj.category : undefined,
        key,
        value,
        source: typeof obj.source === "string" ? obj.source : undefined,
        score: typeof obj.score === "number" ? obj.score : undefined,
        metadata: asRecord(obj.metadata) ?? undefined,
        scope,
        createdAt: toTimestamp(obj.created_at),
        updatedAt: toTimestamp(obj.updated_at),
        touchedAt: toTimestamp(obj.touched_at ?? obj.last_accessed_at),
      });
    }
    return out;
  }

  async list(
    scope: MemoryScope,
    opts?: { query?: string; limit?: number },
  ): Promise<CoreMemoryRecord[]> {
    try {
      const res = await this.client.coreList({
        userId: scope.userId,
        agentId: scope.agentId,
        limit: opts?.limit,
      });
      if (res.status !== "success") return [];

      let records = this.normalizeRecords(res.items, scope);
      if (opts?.query) {
        const q = opts.query;
        records = records
          .map((r) => ({ ...r, score: r.score ?? scoreTextMatch(q, r.key, r.value) }))
          .filter((r) => (r.score ?? 0) > 0)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      }
      const limit = opts?.limit ?? records.length;
      records = records.slice(0, limit);
      this.logger.info(`core-repo: list agent=${scope.agentId} count=${records.length}`);
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
    if (!shouldStoreCoreMemory(key, value, this.maxItemChars)) {
      return false;
    }
    try {
      const res = await this.client.coreUpsert({
        userId: scope.userId,
        agentId: scope.agentId,
        items: [
          {
            category: payload.category?.trim() || inferCategoryFromKey(key),
            key,
            value,
            importance: payload.importance,
            provenance: payload.source ?? "memory-memu",
            validUntil: payload.validUntil,
          },
        ],
      });
      return res.status === "success";
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
          category: item.category.trim() || inferCategoryFromKey(key),
          key,
          value,
          importance: item.importance,
          provenance: item.provenance,
          validUntil: item.validUntil,
        };
      })
      .filter((item) => shouldStoreCoreMemory(item.key, item.value, this.maxItemChars));

    if (normalizedItems.length === 0) return false;

    try {
      const res = await this.client.coreUpsert({
        userId: scope.userId,
        agentId: scope.agentId,
        items: normalizedItems,
      });
      return res.status === "success";
    } catch (err) {
      this.logger.warn(`core-repo: upsertMany failed: ${String(err)}`);
      return false;
    }
  }

  async delete(scope: MemoryScope, ref: { category?: string; key?: string; id?: string }): Promise<boolean> {
    let category = ref.category?.trim();
    let key = ref.key?.trim().toLowerCase();
    if (!category && key) {
      category = inferCategoryFromKey(key);
    }
    if ((!category || !key) && ref.id) {
      const records = await this.list(scope, { limit: 200 });
      const found = records.find((r) => r.id === ref.id);
      if (found) {
        category = found.category;
        key = found.key.trim().toLowerCase();
      }
    }
    if (!category || !key) return false;

    try {
      const res = await this.client.coreDelete({
        userId: scope.userId,
        agentId: scope.agentId,
        category,
        key,
      });
      return res.status === "success" && res.deleted;
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
        .filter((r) => r.key.trim().toLowerCase() === targetKey && (!targetCategory || r.category === targetCategory))
        .map((r) => r.id);
    }

    if (ids.length === 0) return false;

    try {
      const res = await this.client.coreTouch({
        userId: scope.userId,
        agentId: scope.agentId,
        ids,
        kind: ref.kind ?? "access",
      });
      return res.status === "success" && res.touched > 0;
    } catch (err) {
      this.logger.warn(`core-repo: touch failed: ${String(err)}`);
      return false;
    }
  }
}
