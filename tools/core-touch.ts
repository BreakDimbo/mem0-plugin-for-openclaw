import type { CoreMemoryRepository } from "../core-repository.js";
import type { MemuPluginConfig, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";

export function createCoreTouchTool(repo: CoreMemoryRepository, config: MemuPluginConfig, toolCtx?: PluginHookContext) {
  return {
    name: "memory_core_touch",
    description: "Refresh recency for core memory ids[].",
    parameters: {
      type: "object" as const,
      properties: {
        id: { type: "string" as const, description: "Core memory id" },
        ids: { type: "array" as const, items: { type: "string" as const }, description: "Core memory ids to touch" },
        kind: { type: "string" as const, description: "Touch kind: access | injected" },
      },
    },
    execute: async (_id: string, args: { id?: string; ids?: string[]; kind?: "access" | "injected" }) => {
      const ids = Array.isArray(args.ids) && args.ids.length > 0 ? args.ids : args.id ? [args.id] : [];
      if (ids.length === 0) return { text: "Provide id or ids[]." };
      const scope = buildDynamicScope(config.scope, toolCtx);
      const kind = args.kind === "injected" ? "injected" : "access";
      const ok = await repo.touch(scope, { ids, kind });
      return { text: ok ? `Core memory touched: ${ids.length}` : "Touch failed." };
    },
  };
}
