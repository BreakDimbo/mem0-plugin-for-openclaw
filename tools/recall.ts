// ============================================================================
// Tool: memory_recall — explicit memory retrieval
// Phase 2: category filter, maxContextChars
// Aligned with §10.1, §13 scope-aware cache keys
// ============================================================================

import { LRUCache } from "../cache.js";
import type { Metrics } from "../metrics.js";
import type { MemuPluginConfig, MemuMemoryRecord, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";
import { formatMemoriesContext } from "../security.js";
import type { FreeTextBackend } from "../backends/free-text/base.js";
import { rerankMemoryResults } from "../metadata.js";
import { resolveWorkspaceDir, searchWorkspaceFacts } from "../workspace-facts.js";

export function createRecallTool(
  primaryBackend: FreeTextBackend,
  cache: LRUCache<MemuMemoryRecord[]>,
  config: MemuPluginConfig,
  metrics: Metrics,
  toolCtx?: PluginHookContext,
) {
  return {
    name: "memory_recall",
    description: "Search long-term memory for information relevant to a query. Returns matching memories with relevance scores and categories.",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "The search query to find relevant memories" },
        limit: { type: "number" as const, description: "Maximum number of results (default: topK from config)" },
        category: { type: "string" as const, description: "Filter by memory category name" },
      },
      required: ["query"] as const,
    },
    execute: async (_id: string, args: { query: string; limit?: number; category?: string }) => {
      metrics.recallTotal++;
      const start = Date.now();

      try {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return { text: "Please provide a non-empty query." };
        const scope = buildDynamicScope(config.scope, toolCtx);
        const limit = Math.max(1, Math.floor(args.limit ?? config.recall.topK));
        const cacheKey = LRUCache.buildCacheKey(
          `${primaryBackend.provider}\0${query}${args.category ? `\0${args.category}` : ""}`,
          scope.sessionKey,
          limit,
        );
        let memories = cache.get(cacheKey);

        if (memories) {
          metrics.recallHits++;
        } else {
          const searchLimit = Math.min(Math.max(limit * 2, limit), 10);
          memories = await primaryBackend.search(query, scope, {
            maxItems: searchLimit,
            maxContextChars: config.recall.maxChars,
            category: args.category,
            includeSessionScope: true,
          });
          metrics.recallMisses++;
          memories = rerankMemoryResults(query, memories).slice(0, limit);
          if (memories.length > 0) {
            cache.set(cacheKey, memories);
          }
        }

        metrics.recordRecallLatency(Date.now() - start);

        // Workspace fallback removed in config simplification

        const memorySections: string[] = [];
        if (memories.length > 0) {
          memorySections.push(formatMemoriesContext(memories));
        }

        if (memorySections.length === 0) {
          return { text: "No relevant memories found." };
        }

        return { text: memorySections.join("\n\n") };
      } catch (err) {
        metrics.recallErrors++;
        metrics.recordRecallLatency(Date.now() - start);
        return { text: `Memory recall failed: ${String(err)}` };
      }
    },
  };
}
