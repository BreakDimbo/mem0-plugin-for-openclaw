// ============================================================================
// Tool: memory_recall — explicit memory retrieval
// Phase 2: category filter, maxContextChars
// Aligned with §10.1, §13 scope-aware cache keys
// ============================================================================

import type { MemUAdapter } from "../adapter.js";
import { LRUCache } from "../cache.js";
import type { Metrics } from "../metrics.js";
import type { MemuPluginConfig, MemuMemoryRecord, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";
import { formatMemoriesContext } from "../security.js";

export function createRecallTool(
  adapter: MemUAdapter,
  cache: LRUCache<MemuMemoryRecord[]>,
  config: MemuPluginConfig,
  metrics: Metrics,
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
    execute: async (_id: string, args: { query: string; limit?: number; category?: string }, _ctx?: PluginHookContext) => {
      metrics.recallTotal++;
      const start = Date.now();

      try {
        const scope = buildDynamicScope(config.scope, _ctx);
        const limit = args.limit ?? config.recall.topK;
        const cacheKey = LRUCache.buildCacheKey(
          args.query + (args.category ? `\0${args.category}` : ""),
          scope.sessionKey,
          limit,
        );
        let memories = cache.get(cacheKey);

        if (memories) {
          metrics.recallHits++;
        } else {
          memories = await adapter.recall(args.query, scope, {
            maxItems: limit,
            maxContextChars: config.recall.maxContextChars,
            category: args.category,
          });
          metrics.recallMisses++;
          if (memories.length > 0) {
            cache.set(cacheKey, memories);
          }
        }

        metrics.recordRecallLatency(Date.now() - start);

        if (memories.length === 0) {
          return { text: "No relevant memories found." };
        }

        return { text: formatMemoriesContext(memories) };
      } catch (err) {
        metrics.recallErrors++;
        metrics.recordRecallLatency(Date.now() - start);
        return { text: `Memory recall failed: ${String(err)}` };
      }
    },
  };
}
