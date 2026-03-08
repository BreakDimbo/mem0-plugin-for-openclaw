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
        category: { type: "string" as const, description: "Core memory category (default: general)" },
        key: { type: "string" as const, description: "Core memory key (for example: preference.editor)" },
        value: { type: "string" as const, description: "Core memory value to store" },
        importance: { type: "number" as const, description: "Optional importance score" },
        provenance: { type: "string" as const, description: "Optional provenance/source label" },
        validUntil: { type: "string" as const, description: "Optional expiry timestamp (ISO 8601)" },
        items: {
          type: "array" as const,
          description: "Batch upsert items",
          items: {
            type: "object" as const,
            properties: {
              category: { type: "string" as const },
              key: { type: "string" as const },
              value: { type: "string" as const },
              importance: { type: "number" as const },
              provenance: { type: "string" as const },
              validUntil: { type: "string" as const },
            },
            required: ["category", "key", "value"] as const,
          },
        },
      },
    },
    execute: async (
      _id: string,
      args: {
        category?: string;
        key?: string;
        value?: string;
        importance?: number;
        provenance?: string;
        validUntil?: string;
        items?: Array<{
          category: string;
          key: string;
          value: string;
          importance?: number;
          provenance?: string;
          validUntil?: string;
        }>;
      },
    ) => {
      const scope = buildDynamicScope(config.scope, toolCtx);
      if (Array.isArray(args.items) && args.items.length > 0) {
        const ok = await repo.upsertMany(scope, args.items);
        return { text: ok ? `Core memory batch upserted: ${args.items.length} item(s)` : "Core memory batch upsert rejected or failed." };
      }

      const key = args.key?.trim();
      const value = args.value?.trim();
      if (!key || !value) return { text: "Provide key/value or items[]." };

      const ok = await repo.upsert(scope, {
        category: args.category ?? "general",
        key,
        value,
        importance: args.importance,
        source: args.provenance ?? "tool-memory_core_upsert",
        validUntil: args.validUntil,
      });
      if (!ok) return { text: "Core memory upsert rejected or failed." };
      return { text: `Core memory upserted: ${args.category ?? "general"}/${key}` };
    },
  };
}
