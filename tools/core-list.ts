import type { CoreMemoryRepository } from "../core-repository.js";
import type { MemuPluginConfig, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";

export function createCoreListTool(repo: CoreMemoryRepository, config: MemuPluginConfig, toolCtx?: PluginHookContext) {
  return {
    name: "memory_core_list",
    description: "List core memory items for the current scope. Optional query narrows the results.",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Optional search text for core memories" },
        limit: { type: "number" as const, description: "Maximum records to return" },
      },
    },
    execute: async (_id: string, args: { query?: string; limit?: number }) => {
      const scope = buildDynamicScope(config.scope, toolCtx);
      const records = await repo.list(scope, {
        query: args.query,
        limit: args.limit ?? config.core.topK,
      });
      if (records.length === 0) return { text: "No core memories found." };
      return {
        text: records
          .map((r) => `- ${r.id} [${r.key}] ${r.value}${r.score !== undefined ? ` (score=${r.score.toFixed(2)})` : ""}`)
          .join("\n"),
      };
    },
  };
}
