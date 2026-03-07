// ============================================================================
// CLI Commands: /memu status | search | flush | audit
// Phase 3: metrics dashboard, audit log viewer
// ============================================================================

import type { MemUClient } from "./client.js";
import type { MemUAdapter } from "./adapter.js";
import type { LRUCache } from "./cache.js";
import type { OutboxWorker } from "./outbox.js";
import type { Metrics } from "./metrics.js";
import type { MarkdownSync } from "./sync.js";
import type { MemuPluginConfig, MemuMemoryRecord } from "./types.js";
import { formatMemoriesContext, getAuditLog } from "./security.js";

export function createMemuCommand(
  client: MemUClient,
  adapter: MemUAdapter,
  cache: LRUCache<MemuMemoryRecord[]>,
  outbox: OutboxWorker,
  metrics: Metrics,
  sync: MarkdownSync,
  config: MemuPluginConfig,
) {
  return {
    name: "memu",
    description: "memU memory management. Usage: /memu [status|search <query>|flush|audit|dashboard]",
    acceptsArgs: true,
    handler: async (ctx: { args?: string }) => {
      const args = ctx.args?.trim() ?? "";
      const tokens = args.split(/\s+/).filter(Boolean);
      const action = tokens[0]?.toLowerCase() ?? "status";

      if (action === "status") {
        const healthy = await client.healthCheck();
        const lines = [
          "memU Memory Status",
          "══════════════════",
          "",
          "Connection:",
          `  Server:          ${config.memu.baseUrl}`,
          `  Status:          ${healthy ? "Online" : "OFFLINE"}`,
          `  Circuit Breaker: ${client.circuitState} (failures: ${client.failCount})`,
          "",
          "Scope:",
          `  User ID:  ${config.scope.userId}`,
          `  Agent ID: ${config.scope.agentId}`,
          `  Channel:  ${config.scope.channelId ?? "(none)"}`,
          `  Thread:   ${config.scope.threadId ?? "(none)"}`,
          "",
          "Cache:",
          `  Size:     ${cache.size} / ${config.recall.cacheMaxSize}`,
          `  Hit Rate: ${(cache.hitRate * 100).toFixed(1)}% (${cache.hits} hits, ${cache.misses} misses)`,
          "",
          "Outbox:",
          `  Pending:      ${outbox.pending}`,
          `  Sent:         ${outbox.sent}`,
          `  Failed:       ${outbox.failed}`,
          `  Dead Letters: ${outbox.deadLetterCount}`,
          "",
          "Sync:",
          `  Enabled:  ${config.sync.flushToMarkdown}`,
          `  Syncs:    ${sync.syncCount}`,
          `  Written:  ${sync.totalWritten}`,
          `  Last:     ${sync.lastSyncAt ? new Date(sync.lastSyncAt).toISOString() : "never"}`,
        ];
        return { text: lines.join("\n") };
      }

      if (action === "search") {
        const query = tokens.slice(1).join(" ");
        if (!query) {
          return { text: "Usage: /memu search <query>" };
        }

        const memories = await adapter.recall(query, undefined, {
          maxItems: 10,
          maxContextChars: config.recall.maxContextChars,
        });
        if (memories.length === 0) {
          return { text: "No memories found." };
        }

        return { text: formatMemoriesContext(memories) };
      }

      if (action === "flush") {
        const before = outbox.pending;
        await outbox.drain(config.outbox.drainTimeoutMs);
        const after = outbox.pending;
        return { text: `Outbox flushed: ${before - after} items sent, ${after} remaining.` };
      }

      if (action === "dashboard") {
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
        return { text: metrics.formatDashboard(snap) };
      }

      if (action === "audit") {
        const limit = tokens[1] ? parseInt(tokens[1], 10) : 20;
        const entries = getAuditLog(limit);
        if (entries.length === 0) {
          return { text: "No audit entries." };
        }

        const lines = entries.map(
          (e) => `[${e.timestamp}] ${e.action.toUpperCase()} user=${e.userId} agent=${e.agentId} ${e.details}`,
        );
        return { text: ["Audit Log:", "──────────", ...lines].join("\n") };
      }

      return {
        text: [
          "Usage:",
          "  /memu status          — show connection, scope & queue status",
          "  /memu search <query>  — search memories",
          "  /memu flush           — flush pending outbox items",
          "  /memu dashboard       — full metrics dashboard",
          "  /memu audit [limit]   — view audit log",
        ].join("\n"),
      };
    },
  };
}
