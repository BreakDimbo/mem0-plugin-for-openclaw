// ============================================================================
// Contract Adapter: bridges OpenClaw scope model ↔ memU-server API
// Phase 2: full scope mapping, enforcement, maxContextChars truncation
// Aligned with §7.2 scope mapping, §8 API contracts, §15.3 data isolation
// ============================================================================

import type { MemUClient } from "./client.js";
import type { MemoryScope, MemuMemoryRecord, ScopeConfig } from "./types.js";
import { buildScope } from "./types.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

export class MemUAdapter {
  private client: MemUClient;
  private scopeConfig: ScopeConfig;
  private defaultScope: MemoryScope;
  private recallMethod: "rag" | "llm";
  private logger: Logger;
  private warnedUnsupportedScopeFields = false;

  constructor(client: MemUClient, scopeConfig: ScopeConfig, logger: Logger, recallMethod: "rag" | "llm" = "rag") {
    this.client = client;
    this.scopeConfig = scopeConfig;
    this.defaultScope = buildScope(scopeConfig);
    this.recallMethod = recallMethod;
    this.logger = logger;
  }

  private resolveScope(override?: Partial<MemoryScope>): MemoryScope {
    return {
      tenantId: override?.tenantId ?? this.defaultScope.tenantId,
      userId: override?.userId ?? this.defaultScope.userId,
      agentId: override?.agentId ?? this.defaultScope.agentId,
      channelId: override?.channelId ?? this.defaultScope.channelId,
      threadId: override?.threadId ?? this.defaultScope.threadId,
      sessionKey: override?.sessionKey ?? this.defaultScope.sessionKey,
    };
  }

  private enforceScope(scope: MemoryScope): boolean {
    if (this.scopeConfig.requireUserId && !scope.userId) {
      this.logger.warn("memu-adapter: userId is required but missing, rejecting operation");
      return false;
    }
    if (this.scopeConfig.requireAgentId && !scope.agentId) {
      this.logger.warn("memu-adapter: agentId is required but missing, rejecting operation");
      return false;
    }
    return true;
  }

  /**
   * Build memU `where` filter from scope per §7.2 scope mapping.
   * - userId → where.user_id
   * - agentId → where.agent_id__in = [agentId]
   *
   * NOTE:
   * memU user scope filter currently supports user_id / agent_id only.
   * channel_id/thread_id in where triggers server 500:
   * "Unknown filter field 'channel_id' for current user scope".
   */
  private buildWhereFilter(scope: MemoryScope): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (scope.userId) {
      where.user_id = scope.userId;
    }
    if (scope.agentId) {
      where.agent_id__in = [scope.agentId];
    }
    if (
      !this.warnedUnsupportedScopeFields &&
      ((this.scopeConfig.isolateByChannel && scope.channelId) || (this.scopeConfig.isolateByThread && scope.threadId))
    ) {
      this.warnedUnsupportedScopeFields = true;
      this.logger.warn("memu-adapter: channel/thread isolation requested but memU scope filter does not support channel_id/thread_id; falling back to user/agent isolation");
    }
    return where;
  }

  async recall(
    query: string,
    scopeOverride?: Partial<MemoryScope>,
    opts?: { maxItems?: number; maxContextChars?: number; category?: string },
  ): Promise<MemuMemoryRecord[]> {
    const scope = this.resolveScope(scopeOverride);
    if (!this.enforceScope(scope)) return [];

    try {
      const normalizedQuery = typeof query === "string" ? query.trim() : "";
      if (!normalizedQuery) return [];
      const maxQueryChars = Math.max(200, Math.min(4000, opts?.maxContextChars ?? 1200));
      const queryForRetrieve = normalizedQuery.length > maxQueryChars ? normalizedQuery.slice(0, maxQueryChars) : normalizedQuery;
      if (queryForRetrieve.length < normalizedQuery.length) {
        this.logger.warn(`memu-adapter: recall query truncated from ${normalizedQuery.length} to ${queryForRetrieve.length} chars`);
      }

      const where = this.buildWhereFilter(scope);
      const res = await this.client.retrieve({
        query: queryForRetrieve,
        where,
        method: this.recallMethod,
        limit: opts?.maxItems,
      });

      if (res?.status !== "success" || !res.result) {
        this.logger.warn("memu-adapter: retrieve returned non-success or empty result");
        return [];
      }

      const items = Array.isArray(res.result.items) ? res.result.items : [];

      let records: MemuMemoryRecord[] = items
        .map((item: unknown) => {
          if (!item || typeof item !== "object") return null;
          const obj = item as Record<string, unknown>;
          return {
            id: typeof obj.id === "string" ? obj.id : undefined,
            text: String(obj.text ?? obj.content ?? obj.description ?? ""),
            category: String(obj.category ?? obj.category_name ?? ""),
            score: typeof obj.score === "number" ? obj.score : undefined,
            source: "memu_item" as const,
            scope,
            createdAt: typeof obj.created_at === "number" ? obj.created_at : undefined,
          } satisfies MemuMemoryRecord;
        })
        .filter((r): r is MemuMemoryRecord => r !== null && r.text.length > 0);

      // Filter by category if specified
      if (opts?.category) {
        records = records.filter((r) => r.category.toLowerCase().includes(opts.category!.toLowerCase()));
      }

      // Limit count
      const maxItems = opts?.maxItems ?? records.length;
      records = records.slice(0, maxItems);

      // Enforce maxContextChars
      if (opts?.maxContextChars && opts.maxContextChars > 0) {
        let totalChars = 0;
        const truncated: MemuMemoryRecord[] = [];
        for (const r of records) {
          totalChars += r.text.length;
          if (totalChars > opts.maxContextChars) break;
          truncated.push(r);
        }
        records = truncated;
      }

      return records;
    } catch (err) {
      this.logger.warn(`memu-adapter: recall failed: ${String(err)}`);
      return [];
    }
  }

  async memorize(
    text: string,
    scopeOverride?: Partial<MemoryScope>,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const scope = this.resolveScope(scopeOverride);
    if (!this.enforceScope(scope)) return false;

    try {
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);

      // Build metadata with scope info for memU-server
      const enrichedMeta: Record<string, unknown> = {
        ...metadata,
        agent_id: scope.agentId,
        session_key: scope.sessionKey,
      };
      if (scope.channelId) enrichedMeta.channel_id = scope.channelId;
      if (scope.threadId) enrichedMeta.thread_id = scope.threadId;
      if (scope.tenantId) enrichedMeta.tenant_id = scope.tenantId;

      // Build resource_url per §8.4
      const itemId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const resourceUrl = `inline://openclaw/session/${scope.sessionKey}/${itemId}`;

      const res = await this.client.memorize({
        content: [
          {
            role: "user",
            content: { text },
            created_at: now,
          },
        ],
        metadata: enrichedMeta,
        resourceUrl,
        modality: "conversation",
        user: { user_id: scope.userId },
      });

      return res?.status === "success";
    } catch (err) {
      this.logger.warn(`memu-adapter: memorize failed: ${String(err)}`);
      return false;
    }
  }

  async forget(
    scopeOverride?: Partial<MemoryScope>,
  ): Promise<{ purged_categories: number; purged_items: number; purged_resources: number } | null> {
    const scope = this.resolveScope(scopeOverride);
    if (!this.enforceScope(scope)) return null;
    try {
      const res = await this.client.clear(scope.userId, scope.agentId);
      if (res?.status === "success" && res.result) {
        return {
          purged_categories: res.result.purged_categories ?? 0,
          purged_items: res.result.purged_items ?? 0,
          purged_resources: res.result.purged_resources ?? 0,
        };
      }
      return null;
    } catch (err) {
      this.logger.warn(`memu-adapter: forget failed: ${String(err)}`);
      return null;
    }
  }

  async listCategories(scopeOverride?: Partial<MemoryScope>): Promise<Array<{ name: string; description?: string }>> {
    const scope = this.resolveScope(scopeOverride);
    if (!this.enforceScope(scope)) return [];
    try {
      const res = await this.client.categories(scope.userId, scope.agentId);
      if (res?.status === "success" && Array.isArray(res.result?.categories)) {
        return res.result.categories.map((c) => ({
          name: c.name,
          description: c.description,
        }));
      }
      return [];
    } catch (err) {
      this.logger.warn(`memu-adapter: listCategories failed: ${String(err)}`);
      return [];
    }
  }

  getDefaultScope(): MemoryScope {
    return { ...this.defaultScope };
  }

  getScopeConfig(): ScopeConfig {
    return { ...this.scopeConfig };
  }
}
