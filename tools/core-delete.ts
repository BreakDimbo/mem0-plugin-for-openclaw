import type { CoreMemoryRepository } from "../core-repository.js";
import type { MemuPluginConfig, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";

export function createCoreDeleteTool(repo: CoreMemoryRepository, config: MemuPluginConfig, toolCtx?: PluginHookContext) {
  return {
    name: "memory_core_delete",
    description: "Delete a core memory by category+key. id is supported as fallback lookup. Requires confirm=true.",
    parameters: {
      type: "object" as const,
      properties: {
        category: { type: "string" as const, description: "Core memory category" },
        key: { type: "string" as const, description: "Core memory key" },
        id: { type: "string" as const, description: "Core memory id" },
        confirm: { type: "boolean" as const, description: "Must be true to perform deletion" },
      },
      required: ["confirm"] as const,
    },
    execute: async (_id: string, args: { category?: string; key?: string; id?: string; confirm: boolean }) => {
      if (!args.confirm) return { text: "Deletion cancelled. Set confirm=true." };
      if (!args.id && (!args.category || !args.key)) return { text: "Provide category+key or id." };
      const scope = buildDynamicScope(config.scope, toolCtx);
      const ok = await repo.delete(scope, { category: args.category, key: args.key, id: args.id });
      return { text: ok ? "Core memory deleted." : "Delete failed." };
    },
  };
}
