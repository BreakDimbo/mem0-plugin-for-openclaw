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
          text: "Please provide a memoryId for single-item deletion or a query to delete matching memories. Scope-level clear-all is not supported by the current backend.",
        };
      }

      const result = await backend.forget(scope, { query: args.query });

      if (!result) {
        return { text: "Failed to clear memories. The backend may not support this operation." };
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
