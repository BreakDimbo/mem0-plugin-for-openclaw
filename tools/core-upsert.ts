import type { CoreMemoryRepository } from "../core-repository.js";
import type { MemuPluginConfig, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";

export function createCoreUpsertTool(repo: CoreMemoryRepository, config: MemuPluginConfig, toolCtx?: PluginHookContext) {
  return {
    name: "memory_core_upsert",
    description: "Create or update a core memory key/value for the current scope.",
    parameters: {
      type: "object" as const,
      properties: {
        key: { type: "string" as const, description: "Core memory key (for example: preference.editor)" },
        value: { type: "string" as const, description: "Core memory value to store" },
      },
      required: ["key", "value"] as const,
    },
    execute: async (_id: string, args: { key: string; value: string }) => {
      const scope = buildDynamicScope(config.scope, toolCtx);
      const ok = await repo.upsert(scope, {
        key: args.key,
        value: args.value,
        source: "tool-memory_core_upsert",
      });
      if (!ok) return { text: "Core memory upsert rejected or failed." };
      return { text: `Core memory upserted: ${args.key}` };
    },
  };
}
