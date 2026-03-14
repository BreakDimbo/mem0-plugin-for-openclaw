// ============================================================================
// Tool: memory_stats — show plugin diagnostics + metrics dashboard
// Phase 3: full metrics snapshot
// ============================================================================

import type { LRUCache } from "../cache.js";
import type { OutboxWorker } from "../outbox.js";
import type { Metrics } from "../metrics.js";
import type { MemuMemoryRecord, PluginHookContext } from "../types.js";
import type { FreeTextBackend } from "../backends/free-text/base.js";

export function createStatsTool(
  client: {
    healthCheck(): Promise<boolean>;
    totalRequests: number;
    totalErrors: number;
    circuitState: string;
    latencyStats: { p50: number; p95: number; p99: number };
  } | null,
  primaryBackend: FreeTextBackend,
  fallbackBackend: FreeTextBackend | null,
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
      const healthy = client ? await client.healthCheck() : true;
      const primaryStatus = await primaryBackend.healthCheck();
      const fallbackStatus = fallbackBackend ? await fallbackBackend.healthCheck() : null;
      const snap = metrics.snapshot({
        outbox: {
          sent: outbox.sent,
          failed: outbox.failed,
          pending: outbox.pending,
          deadLetterCount: outbox.deadLetterCount,
          oldestPendingAgeMs: outbox.oldestPendingAgeMs,
          lastSentAt: outbox.lastSentAt,
          lastFailedAt: outbox.lastFailedAt,
        },
        cache: {
          size: cache.size,
          hits: cache.hits,
          misses: cache.misses,
          hitRate: cache.hitRate,
        },
        client: {
          totalRequests: client?.totalRequests ?? 0,
          totalErrors: client?.totalErrors ?? 0,
          circuitState: client?.circuitState ?? "disabled",
          latencyStats: client?.latencyStats ?? { p50: 0, p95: 0, p99: 0 },
        },
      });

      const dashboard = metrics.formatDashboard(snap);
      const statusLine = client
        ? healthy ? "Connection: Online" : "Connection: OFFLINE"
        : "Connection: Disabled (memU server not in use)";
      const backendLines = [
        `Free-text backend: ${primaryStatus.provider} (${primaryStatus.healthy ? "Online" : "OFFLINE"})`,
        ...(fallbackStatus ? [`Fallback backend: ${fallbackStatus.provider} (${fallbackStatus.healthy ? "Online" : "OFFLINE"})`] : []),
      ];

      return { text: `${statusLine}\n${backendLines.join("\n")}\n\n${dashboard}` };
    },
  };
}
