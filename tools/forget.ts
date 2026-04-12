// ============================================================================
// Tool: memory_forget — delete specific or all memories with audit logging
// Aligned with §10.3: supports memoryId or query-based deletion
// ============================================================================

import type { MemuPluginConfig, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";
import { audit } from "../security.js";
import type { FreeTextBackend } from "../backends/free-text/base.js";

export function createForgetTool(backend: FreeTextBackend, config: MemuPluginConfig, toolCtx?: PluginHookContext) {
  return {
    name: "memory_forget",
    description:
      "Delete memories from long-term storage. Provide a memoryId for single-item deletion, or provide a query to delete matching memories. Requires explicit confirmation.",
    parameters: {
      type: "object" as const,
      properties: {
        confirm: { type: "boolean" as const, description: "Must be true to confirm deletion" },
        memoryId: { type: "string" as const, description: "Specific memory ID to delete" },
        query: { type: "string" as const, description: "Query to identify which memories to forget" },
      },
      required: ["confirm"] as const,
    },
    execute: async (_id: string, args: { confirm: boolean; memoryId?: string; query?: string }) => {
      if (!args.confirm) {
        return { text: "Deletion cancelled. Set confirm=true to proceed." };
      }

      const scope = buildDynamicScope(config.scope, toolCtx);

      // If memoryId is provided, attempt targeted deletion via backend
      if (args.memoryId) {
        audit(
          "forget",
          scope.userId,
          scope.agentId,
          `targeted forget: memoryId="${args.memoryId}"${args.query ? `, query="${args.query}"` : ""}`,
        );

        const result = await backend.forget(scope, { memoryId: args.memoryId });
        if (!result) {
          return {
            text: `Failed to delete memory (memoryId=${args.memoryId}). The backend may not support per-item deletion.`,
          };
        }
        return {
          text: `Deleted memory: memoryId=${args.memoryId} (items purged: ${result.purged_items})`,
        };
      }

      if (!args.query) {
        return {
          text: "Please provide a memoryId for single-item deletion or a query to find matching memories. Scope-level clear-all is not supported by the current backend.",
        };
      }

      // Safety gate: semantic search can match far more than intended.
      // Preview matches and only auto-delete when exactly one high-confidence match is found.
      const matches = await backend.search(args.query, scope, { maxItems: 10 });
      if (!matches || matches.length === 0) {
        return { text: "No matching memories found." };
      }
      if (matches.length === 1) {
        const targetId = matches[0].id;
        if (!targetId) {
          return { text: "Found a matching memory but it has no ID. Cannot delete." };
        }
        const result = await backend.forget(scope, { memoryId: targetId });
        audit(
          "forget",
          scope.userId,
          scope.agentId,
          `auto-deleted single match for query="${args.query}": memoryId="${targetId}", purged=${result?.purged_items ?? 0}`,
        );
        return {
          text: `Deleted 1 matching memory (memoryId=${targetId}). To avoid accidental batch deletion, query-based forget only auto-deletes when exactly 1 match is found.`,
        };
      }

      // Multiple matches — require explicit memoryId to prevent mass deletion
      const list = matches
        .map((m) => `- memoryId=${m.id} | score=${m.score?.toFixed(3) ?? "N/A"} | ${m.text?.slice(0, 60) ?? ""}...`)
        .join("\n");
      return {
        text: [
          `Found ${matches.length} matching memories. Query-based semantic search can match more items than intended.`,
          "To prevent accidental mass deletion, automatic batch delete is disabled.",
          "Please re-run memory_forget with memoryId=<id> and confirm=true to delete a specific item:",
          list,
        ].join("\n"),
      };
    },
  };
}
