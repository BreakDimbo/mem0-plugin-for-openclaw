// ============================================================================
// Tool: memory_stats — show plugin diagnostics + metrics dashboard
// Phase 3: full metrics snapshot
// ============================================================================

import type { MemUClient } from "../client.js";
import type { LRUCache } from "../cache.js";
import type { OutboxWorker } from "../outbox.js";
import type { Metrics } from "../metrics.js";
import type { MemuMemoryRecord, PluginHookContext } from "../types.js";

export function createStatsTool(
  client: MemUClient,
  cache: LRUCache<MemuMemoryRecord[]>,
  outbox: OutboxWorker,
  metrics: Metrics,
  _toolCtx?: PluginHookContext,
) {
  return {
    name: "memory_stats",
    description: "Show memory plugin diagnostics: connection status, recall/capture/outbox/cache metrics, circuit breaker state, latency percentiles.",
    parameters: {
      type: "object" as const,
      properties: {},
    },
    execute: async (_id: string) => {
      const healthy = await client.healthCheck();
      const snap = metrics.snapshot({
        outbox: {
          sent: outbox.sent,
          failed: outbox.failed,
          pending: outbox.pending,
          deadLetterCount: outbox.deadLetterCount,
        },
        cache: {
          size: cache.size,
          hits: cache.hits,
          misses: cache.misses,
          hitRate: cache.hitRate,
        },
        client: {
          totalRequests: client.totalRequests,
          totalErrors: client.totalErrors,
          circuitState: client.circuitState,
          latencyStats: client.latencyStats,
        },
      });

      const dashboard = metrics.formatDashboard(snap);
      const statusLine = healthy ? "Connection: Online" : "Connection: OFFLINE";

      return { text: `${statusLine}\n\n${dashboard}` };
    },
  };
}
