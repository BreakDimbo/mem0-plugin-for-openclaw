// ============================================================================
// CLI Commands: /memu status | search | flush | audit
// Phase 3: metrics dashboard, audit log viewer
// ============================================================================

import type { LRUCache } from "./cache.js";
import type { OutboxWorker } from "./outbox.js";
import type { Metrics } from "./metrics.js";
import type { MarkdownSync } from "./sync.js";
import type { CoreMemoryRepository } from "./core-repository.js";
import type { CoreProposalQueue } from "./core-proposals.js";
import type { MemuPluginConfig, MemuMemoryRecord, PluginHookContext } from "./types.js";
import { buildDynamicScope } from "./types.js";
import { formatMemoriesContext, getAuditLog } from "./security.js";
import type { FreeTextBackend } from "./backends/free-text/base.js";
import { rerankMemoryResults } from "./metadata.js";

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

function parseCoreRef(raw: string | undefined): { id?: string; key?: string } {
  const token = (raw ?? "").trim();
  if (!token) return {};
  if (token.startsWith("id:")) return { id: token.slice(3).trim() || undefined };
  if (token.startsWith("key:")) return { key: token.slice(4).trim() || undefined };
  return token.includes(".") ? { key: token } : { id: token };
}

export function createMemuCommand(
  primaryBackend: FreeTextBackend,
  coreRepo: CoreMemoryRepository,
  proposalQueue: CoreProposalQueue,
  cache: LRUCache<MemuMemoryRecord[]>,
  outbox: OutboxWorker,
  metrics: Metrics,
  sync: MarkdownSync,
  config: MemuPluginConfig,
  runtime: any,
) {
  return {
    name: "memu",
    description: "memU memory management. Usage: /memu [status|search|compare|benchmark|flush|audit|dashboard|core ...]",
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
        sessionKey: route?.sessionKey,
      };
      const runtimeScope = buildDynamicScope(config.scope, scopeCtx);

      if (action === "status") {
        const backendStatus = await primaryBackend.healthCheck();
        const recentOutbox = outbox.recent
          .slice(-5)
          .map((event) => {
            const pieces = [
              `${new Date(event.at).toISOString()} ${event.type}`,
              `id=${event.id}`,
              event.agentId ? `agent=${event.agentId}` : "",
              event.memoryKind ? `kind=${event.memoryKind}` : "",
              event.quality ? `quality=${event.quality}` : "",
              typeof event.retryCount === "number" ? `retry=${event.retryCount}` : "",
              event.error ? `error=${event.error}` : "",
            ].filter(Boolean);
            return `  - ${pieces.join(" ")}`;
          });
        const lines = [
          "memU Memory Status",
          "══════════════════",
          "",
          "Connection:",
          "  Server:          (local core store)",
          "  Status:          active",
          "  Circuit Breaker: disabled",
          "",
          "Free-text Backend:",
          `  Primary:         ${backendStatus.provider} (${backendStatus.healthy ? "Online" : "OFFLINE"})`,
          "",
          "Scope:",
          `  User ID:  ${runtimeScope.userId}`,
          `  Agent ID: ${runtimeScope.agentId}`,
          `  Session:  ${runtimeScope.sessionKey}`,
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
          `  Oldest Age:   ${outbox.oldestPendingAgeMs === null ? "none" : `${Math.round(outbox.oldestPendingAgeMs / 1000)}s`}`,
          `  Last Enqueue: ${outbox.lastEnqueuedAt ? new Date(outbox.lastEnqueuedAt).toISOString() : "never"}`,
          `  Last Sent:    ${outbox.lastSentAt ? new Date(outbox.lastSentAt).toISOString() : "never"}`,
          `  Last Failed:  ${outbox.lastFailedAt ? new Date(outbox.lastFailedAt).toISOString() : "never"}`,
          ...(recentOutbox.length > 0 ? ["  Recent:", ...recentOutbox] : []),
          "",
          "Core:",
          `  Enabled:           ${config.core.enabled}`,
          `  Pending Proposals: ${proposalQueue.pendingCount}`,
          "",
          "Sync:",
          `  Enabled:  ${config.sync.flushToMarkdown}`,
          `  Syncs:    ${sync.syncCount}`,
          `  Written:  ${sync.totalWritten}`,
          `  Last:     ${sync.lastSyncAt ? new Date(sync.lastSyncAt).toISOString() : "never"}`,
        ];
        return { text: lines.join("\n") };
      }

      if (action === "sync") {
        const targetAgentId = (tokens[1] ?? "").trim() || runtimeScope.agentId;
        const result = await sync.forceSync(targetAgentId);
        return { text: `Markdown sync completed for: ${result.syncedAgents.join(", ") || "(none)"}` };
      }

      if (action === "search") {
        const query = tokens.slice(1).join(" ");
        if (!query) {
          return { text: "Usage: /memu search <query>" };
        }

        let memories = await primaryBackend.search(query, runtimeScope, {
          maxItems: 10,
          maxContextChars: config.recall.maxContextChars,
          includeSessionScope: true,
        });
        memories = rerankMemoryResults(query, memories).slice(0, 10);
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
            totalRequests: 0,
            totalErrors: 0,
            circuitState: "disabled",
            latencyStats: { p50: 0, p95: 0, p99: 0 },
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

      if (action === "core") {
        const sub = tokens[1]?.toLowerCase() ?? "list";
        const ref = parseCoreRef(tokens[2]);

        if (sub === "list") {
          const maybeLimit = Number.parseInt(tokens[2] ?? "", 10);
          const limit = Number.isFinite(maybeLimit) ? maybeLimit : config.core.topK;
          const query = Number.isFinite(maybeLimit) ? tokens.slice(3).join(" ") : tokens.slice(2).join(" ");
          const records = await coreRepo.list(runtimeScope, {
            limit,
            query: query || undefined,
          });
          if (records.length === 0) return { text: "No core memories found." };
          return { text: records.map((r) => `- ${r.id} [${r.category ?? "general"}/${r.key}] ${r.value}`).join("\n") };
        }

        if (sub === "upsert") {
          const key = (tokens[2] ?? "").trim();
          const value = tokens.slice(3).join(" ").trim();
          if (!key || !value) return { text: "Usage: /memu core upsert <key> <value>" };
          const ok = await coreRepo.upsert(runtimeScope, { key, value, source: "cli" });
          return { text: ok ? `Core memory upserted: ${key}` : "Core memory upsert rejected or failed." };
        }

        if (sub === "delete") {
          if (!ref.id && !ref.key) return { text: "Usage: /memu core delete <id|key:...>" };
          const ok = await coreRepo.delete(runtimeScope, ref);
          return { text: ok ? "Core memory deleted." : "Core memory delete failed." };
        }

        if (sub === "touch") {
          if (!ref.id && !ref.key) return { text: "Usage: /memu core touch <id|key:...>" };
          const ok = await coreRepo.touch(runtimeScope, ref);
          return { text: ok ? "Core memory touched." : "Core memory touch failed." };
        }

        if (sub === "proposals") {
          const limit = tokens[2] ? Number.parseInt(tokens[2], 10) : 20;
          const items = proposalQueue.listForScope(runtimeScope, "pending", Number.isFinite(limit) ? limit : 20);
          if (items.length === 0) return { text: "No pending proposals." };
          return { text: items.map((p) => `- ${p.id} [${p.category}/${p.key}] ${p.value} (${p.reason})`).join("\n") };
        }

        if (sub === "approve") {
          const proposalId = (tokens[2] ?? "").trim();
          if (!proposalId) return { text: "Usage: /memu core approve <proposalId>" };
          const proposal = proposalQueue.approve(proposalId, "cli");
          if (!proposal) return { text: "Proposal not found or already reviewed." };
          const ok = await coreRepo.upsert(proposal.scope, {
            category: proposal.category,
            key: proposal.key,
            value: proposal.value,
            source: "proposal-approved-cli",
            metadata: { proposal_id: proposal.id },
          });
          return { text: ok ? `Proposal approved and stored: ${proposal.id}` : `Proposal approved but store failed: ${proposal.id}` };
        }

        if (sub === "reject") {
          const proposalId = (tokens[2] ?? "").trim();
          if (!proposalId) return { text: "Usage: /memu core reject <proposalId>" };
          const proposal = proposalQueue.reject(proposalId, "cli");
          return { text: proposal ? `Proposal rejected: ${proposal.id}` : "Proposal not found or already reviewed." };
        }

        if (sub === "consolidate") {
          const dryRun = tokens.includes("--dry-run");
          const result = await coreRepo.consolidate(runtimeScope, {
            dryRun,
            similarityThreshold: config.core.consolidation.similarityThreshold,
          });
          const label = dryRun ? " (dry-run)" : "";
          return {
            text: `Core consolidation${label}: ${result.deleted} exact-key duplicates removed, ${result.merged} near-duplicate values merged, ${result.unchanged} unchanged.`,
          };
        }

        return {
          text: [
            "Usage:",
            "  /memu core list [limit] [query]",
            "  /memu core upsert <key> <value>",
            "  /memu core delete <id|key:...>",
            "  /memu core touch <id|key:...>",
            "  /memu core consolidate [--dry-run]",
            "  /memu core proposals [limit]",
            "  /memu core approve <proposalId>",
            "  /memu core reject <proposalId>",
          ].join("\n"),
        };
      }

      return {
        text: [
          "Usage:",
          "  /memu status          — show connection, scope & queue status",
          "  /memu sync [agentId]  — force Markdown sync",
          "  /memu search <query>  — search memories",
          "  /memu flush           — flush pending outbox items",
          "  /memu dashboard       — full metrics dashboard",
          "  /memu audit [limit]   — view audit log",
          "  /memu core ...        — manage core memories and proposals",
        ].join("\n"),
      };
    },
  };
}
