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
import type { MemuPluginConfig, MemuMemoryRecord, PluginHookContext } from "./types.js";
import { buildDynamicScope } from "./types.js";
import { formatMemoriesContext, getAuditLog } from "./security.js";

function inferPeerKindFromId(id: string): "direct" | "group" | "channel" {
  const raw = id.trim().toLowerCase();
  if (!raw) return "direct";
  if (raw.startsWith("channel:")) return "channel";
  if (raw.startsWith("group:")) return "group";
  if (raw.startsWith("chat:")) return "group";
  if (raw.startsWith("room:")) return "group";
  if (raw.includes(":channel:")) return "channel";
  if (raw.includes(":group:")) return "group";
  if (raw.includes("@g.us")) return "group"; // WhatsApp groups
  return "direct";
}

function looksLikeConversationId(id: string): boolean {
  const raw = id.trim().toLowerCase();
  if (!raw) return false;
  if (raw.startsWith("user:")) return true;
  if (raw.startsWith("chat:")) return true;
  if (raw.startsWith("channel:")) return true;
  if (raw.startsWith("group:")) return true;
  if (raw.startsWith("room:")) return true;
  if (raw.includes(":group:") || raw.includes(":channel:")) return true;
  if (raw.includes("@g.us")) return true;
  return false;
}

function resolvePeerFromPluginCommandCtx(ctx: any): { kind: "direct" | "group" | "channel"; id: string } | null {
  const candidates: string[] = [];

  // Prefer sender identity in DM contexts.
  if (typeof ctx?.senderOpenId === "string" && looksLikeConversationId(ctx.senderOpenId)) candidates.push(ctx.senderOpenId);
  if (typeof ctx?.senderId === "string" && looksLikeConversationId(ctx.senderId)) candidates.push(ctx.senderId);
  if (typeof ctx?.from === "string" && looksLikeConversationId(ctx.from)) candidates.push(ctx.from);
  if (typeof ctx?.to === "string" && looksLikeConversationId(ctx.to)) candidates.push(ctx.to);

  // Fallbacks
  if (typeof ctx?.senderOpenId === "string") candidates.push(ctx.senderOpenId);
  if (typeof ctx?.senderId === "string") candidates.push(ctx.senderId);
  if (typeof ctx?.from === "string") candidates.push(ctx.from);
  if (typeof ctx?.to === "string") candidates.push(ctx.to);

  const id = candidates.map((v) => (v ?? "").trim()).find(Boolean);
  if (!id) return null;

  return {
    kind: inferPeerKindFromId(id),
    id,
  };
}

export function createMemuCommand(
  client: MemUClient,
  adapter: MemUAdapter,
  cache: LRUCache<MemuMemoryRecord[]>,
  outbox: OutboxWorker,
  metrics: Metrics,
  sync: MarkdownSync,
  config: MemuPluginConfig,
  runtime: any,
) {
  return {
    name: "memu",
    description: "memU memory management. Usage: /memu [status|search <query>|flush|audit|dashboard]",
    acceptsArgs: true,
    handler: async (ctx: any) => {
      const args = (typeof ctx?.args === "string" ? ctx.args : "").trim();
      const tokens = args.split(/\s+/).filter(Boolean);
      const action = tokens[0]?.toLowerCase() ?? "status";

      // Plugin commands (registerCommand) do NOT receive agentId/sessionKey.
      // Derive them via core routing as best-effort.
      const channel = String(ctx?.channel ?? "").trim().toLowerCase() || "unknown";
      const accountId = String(ctx?.accountId ?? "default").trim() || "default";
      const peer = resolvePeerFromPluginCommandCtx(ctx);

      let route: { agentId: string; sessionKey: string; matchedBy?: string } | null = null;
      try {
        if (runtime?.channel?.routing?.resolveAgentRoute && ctx?.config) {
          route = runtime.channel.routing.resolveAgentRoute({
            cfg: ctx.config,
            channel,
            accountId,
            peer,
          });
        }
      } catch {
        route = null;
      }

      const scopeCtx: PluginHookContext = {
        agentId: route?.agentId,
        channelId: channel,
        sessionKey: route?.sessionKey,
      };
      const runtimeScope = buildDynamicScope(config.scope, scopeCtx);

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
          `  User ID:  ${runtimeScope.userId}`,
          `  Agent ID: ${runtimeScope.agentId}`,
          `  Session:  ${runtimeScope.sessionKey}`,
          `  Channel:  ${runtimeScope.channelId ?? "(none)"}`,
          `  Thread:   ${runtimeScope.threadId ?? "(none)"}`,
          ...(route ? [`  Route:    matchedBy=${route.matchedBy ?? "(unknown)"} peer=${peer ? `${peer.kind}:${peer.id}` : "(none)"}`] : []),
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

        const memories = await adapter.recall(query, runtimeScope, {
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
