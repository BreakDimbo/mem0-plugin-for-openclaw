import type { CoreMemoryRepository } from "../core-repository.js";
import type { MemuPluginConfig, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";

export function createCoreTouchTool(repo: CoreMemoryRepository, config: MemuPluginConfig, toolCtx?: PluginHookContext) {
  return {
    name: "memory_core_touch",
    description: "Refresh recency of a core memory by id or key.",
    parameters: {
      type: "object" as const,
      properties: {
        id: { type: "string" as const, description: "Core memory id" },
        key: { type: "string" as const, description: "Core memory key" },
      },
    },
    execute: async (_id: string, args: { id?: string; key?: string }) => {
      if (!args.id && !args.key) return { text: "Provide id or key." };
      const scope = buildDynamicScope(config.scope, toolCtx);
      const ok = await repo.touch(scope, { id: args.id, key: args.key });
      return { text: ok ? "Core memory touched." : "Touch failed." };
    },
  };
}
