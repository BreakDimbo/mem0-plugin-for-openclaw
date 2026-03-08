import type { CoreMemoryRepository } from "../core-repository.js";
import type { MemuPluginConfig, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";

export function createCoreDeleteTool(repo: CoreMemoryRepository, config: MemuPluginConfig, toolCtx?: PluginHookContext) {
  return {
    name: "memory_core_delete",
    description: "Delete a core memory by id or key. Requires confirm=true.",
    parameters: {
      type: "object" as const,
      properties: {
        id: { type: "string" as const, description: "Core memory id" },
        key: { type: "string" as const, description: "Core memory key" },
        confirm: { type: "boolean" as const, description: "Must be true to perform deletion" },
      },
      required: ["confirm"] as const,
    },
    execute: async (_id: string, args: { id?: string; key?: string; confirm: boolean }) => {
      if (!args.confirm) return { text: "Deletion cancelled. Set confirm=true." };
      if (!args.id && !args.key) return { text: "Provide id or key." };
      const scope = buildDynamicScope(config.scope, toolCtx);
      const ok = await repo.delete(scope, { id: args.id, key: args.key });
      return { text: ok ? "Core memory deleted." : "Delete failed." };
    },
  };
}
