// ============================================================================
// Hook: before_agent_start — inject recalled memories into context
// Phase 2: metrics integration, maxContextChars, improved logging
// Aligned with §9.1 recall flow, §13 scope-aware cache keys
// ============================================================================

import type { MemUAdapter } from "../adapter.js";
import { LRUCache } from "../cache.js";
import type { Metrics } from "../metrics.js";
import type { MarkdownSync } from "../sync.js";
import type { MemuPluginConfig, MemuMemoryRecord, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";
import { formatMemoriesContext } from "../security.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

export function createRecallHook(
  adapter: MemUAdapter,
  cache: LRUCache<MemuMemoryRecord[]>,
  config: MemuPluginConfig,
  logger: Logger,
  metrics: Metrics,
  sync: MarkdownSync,
) {
  return async (event: { prompt?: string; messages?: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }> }, ctx: PluginHookContext) => {
    if (!config.recall.enabled) return;

    // Register agent workspace for sync
    if (ctx.agentId && ctx.workspaceDir) {
      sync.registerAgent(ctx.agentId, ctx.workspaceDir);
    }

    // Extract query from the latest user input
    let query = event.prompt ?? "";
    if (!query && event.messages) {
      const userMsgs = event.messages.filter((m) => m.role === "user");
      const last = userMsgs[userMsgs.length - 1];
      if (last?.content) {
        if (typeof last.content === "string") {
          query = last.content;
        } else if (Array.isArray(last.content)) {
          query = last.content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
        }
      }
    }

    if (!query || query.length < 3) return;

    metrics.recallTotal++;
    const start = Date.now();

    try {
      // Build scope-aware cache key per §13
      const scope = buildDynamicScope(config.scope, ctx);
      const scopeKey = scope.sessionKey;
      const cacheKey = LRUCache.buildCacheKey(query, scopeKey, config.recall.topK);
      const cached = cache.get(cacheKey);

      let memories: MemuMemoryRecord[];
      if (cached) {
        memories = cached;
        metrics.recallHits++;
        logger.info(`recall-hook: cache hit key=${cacheKey} count=${memories.length}`);
      } else {
        memories = await adapter.recall(query, scope, {
          maxItems: config.recall.topK,
          maxContextChars: config.recall.maxContextChars,
        });
        metrics.recallMisses++;
        if (memories.length > 0) {
          cache.set(cacheKey, memories);
        }
        logger.info(`recall-hook: fetched ${memories.length} memories for query="${query.slice(0, 60)}..."`);
      }

      metrics.recordRecallLatency(Date.now() - start);

      // Filter by score threshold
      const filtered = memories.filter(
        (m) => m.score === undefined || m.score >= config.recall.scoreThreshold,
      );

      if (filtered.length === 0) return;

      const formatted = formatMemoriesContext(filtered);
      return { prependContext: formatted };
    } catch (err) {
      metrics.recallErrors++;
      metrics.recordRecallLatency(Date.now() - start);
      logger.warn(`recall-hook: error: ${String(err)}`);
      return;
    }
  };
}
