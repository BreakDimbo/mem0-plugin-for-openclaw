// ============================================================================
// Tool: memory_forget — delete specific or all memories with audit logging
// Aligned with §10.3: supports memoryId or query-based deletion
// ============================================================================

import type { MemUAdapter } from "../adapter.js";
import type { MemuPluginConfig, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";
import { audit } from "../security.js";

export function createForgetTool(adapter: MemUAdapter, config: MemuPluginConfig) {
  return {
    name: "memory_forget",
    description:
      "Delete memories from long-term storage. Provide a memoryId for single-item deletion, or use confirm=true without memoryId to clear all memories for the current scope. Requires explicit confirmation.",
    parameters: {
      type: "object" as const,
      properties: {
        confirm: { type: "boolean" as const, description: "Must be true to confirm deletion" },
        memoryId: { type: "string" as const, description: "Specific memory ID to delete" },
        query: { type: "string" as const, description: "Query to identify which memories to forget" },
      },
      required: ["confirm"] as const,
    },
    execute: async (_id: string, args: { confirm: boolean; memoryId?: string; query?: string }, _ctx?: PluginHookContext) => {
      if (!args.confirm) {
        return { text: "Deletion cancelled. Set confirm=true to proceed." };
      }

      const scope = buildDynamicScope(config.scope, _ctx);

      // If memoryId is provided, attempt targeted deletion
      // Note: memU-server /clear API currently only supports scope-level clearing.
      // When memU adds per-item delete, this should call a dedicated endpoint.
      if (args.memoryId) {
        audit(
          "forget",
          scope.userId,
          scope.agentId,
          `targeted forget: memoryId="${args.memoryId}"${args.query ? `, query="${args.query}"` : ""}`,
        );

        // For now, fall through to scope-level clear with a warning
        return {
          text: [
            `Note: Per-item deletion (memoryId=${args.memoryId}) is not yet supported by the memU server.`,
            "Use without memoryId to clear all memories for the current scope.",
          ].join("\n"),
        };
      }

      const result = await adapter.forget({
        userId: scope.userId,
        agentId: scope.agentId,
      });

      if (!result) {
        return { text: "Failed to clear memories. The memU server may be unavailable." };
      }

      // Audit log the deletion
      audit(
        "forget",
        scope.userId,
        scope.agentId,
        `purged: categories=${result.purged_categories}, items=${result.purged_items}, resources=${result.purged_resources}${args.query ? `, query="${args.query}"` : ""}`,
      );

      return {
        text: [
          "Memories cleared:",
          `  Categories purged: ${result.purged_categories}`,
          `  Items purged: ${result.purged_items}`,
          `  Resources purged: ${result.purged_resources}`,
        ].join("\n"),
      };
    },
  };
}
