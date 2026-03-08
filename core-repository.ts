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

export class CoreMemoryRepository {
  private readonly client: MemUClient;
  private readonly logger: Logger;
  private readonly maxItemChars: number;

  constructor(client: MemUClient, logger: Logger, maxItemChars: number) {
    this.client = client;
    this.logger = logger;
    this.maxItemChars = maxItemChars;
  }

  private normalizeRecords(result: unknown, scope: MemoryScope): CoreMemoryRecord[] {
    const root = asRecord(result);
    const candidates =
      (Array.isArray(root?.memories) && root?.memories) ||
      (Array.isArray(root?.items) && root?.items) ||
      (Array.isArray(root?.records) && root?.records) ||
      (Array.isArray(result) ? result : []);

    if (!Array.isArray(candidates)) return [];

    const out: CoreMemoryRecord[] = [];
    for (const raw of candidates) {
      const obj = asRecord(raw);
      if (!obj) continue;

      const id = String(obj.id ?? obj.memory_id ?? obj.key ?? "");
      const key = String(obj.key ?? obj.name ?? obj.memory_key ?? "").trim().toLowerCase();
      const valueRaw = String(obj.value ?? obj.text ?? obj.content ?? "").trim();
      if (!id || !key || !valueRaw) continue;

      const value = sanitizeCoreValue(valueRaw, this.maxItemChars);
      if (!shouldStoreCoreMemory(key, value, this.maxItemChars)) continue;

      out.push({
        id,
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
    opts?: { query?: string; limit?: number; touchOnRead?: boolean },
  ): Promise<CoreMemoryRecord[]> {
    try {
      const res = await this.client.coreList({
        userId: scope.userId,
        agentId: scope.agentId,
        limit: opts?.limit,
      });
      if (res.status !== "success") return [];

      let records = this.normalizeRecords(res.result, scope);
      if (opts?.query) {
        const q = opts.query;
        records = records
          .map((r) => ({ ...r, score: r.score ?? scoreTextMatch(q, r.key, r.value) }))
          .filter((r) => (r.score ?? 0) > 0)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      }
      const limit = opts?.limit ?? records.length;
      records = records.slice(0, limit);

      if (opts?.touchOnRead) {
        for (const r of records) {
          this.touch(scope, { id: r.id }).catch(() => {});
        }
      }
      return records;
    } catch (err) {
      this.logger.warn(`core-repo: list failed: ${String(err)}`);
      return [];
    }
  }

  async upsert(
    scope: MemoryScope,
    payload: { key: string; value: string; source?: string; metadata?: Record<string, unknown> },
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
        key,
        value,
        source: payload.source ?? "memory-memu",
        metadata: payload.metadata,
      });
      return res.status === "success";
    } catch (err) {
      this.logger.warn(`core-repo: upsert failed: ${String(err)}`);
      return false;
    }
  }

  async delete(scope: MemoryScope, ref: { id?: string; key?: string }): Promise<boolean> {
    try {
      const res = await this.client.coreDelete({
        userId: scope.userId,
        agentId: scope.agentId,
        id: ref.id,
        key: ref.key?.trim().toLowerCase(),
      });
      return res.status === "success";
    } catch (err) {
      this.logger.warn(`core-repo: delete failed: ${String(err)}`);
      return false;
    }
  }

  async touch(scope: MemoryScope, ref: { id?: string; key?: string }): Promise<boolean> {
    try {
      const res = await this.client.coreTouch({
        userId: scope.userId,
        agentId: scope.agentId,
        id: ref.id,
        key: ref.key?.trim().toLowerCase(),
      });
      return res.status === "success";
    } catch (err) {
      this.logger.warn(`core-repo: touch failed: ${String(err)}`);
      return false;
    }
  }
}
