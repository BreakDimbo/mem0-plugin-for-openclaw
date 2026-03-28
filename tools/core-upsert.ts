import type { CoreMemoryRepository } from "../core-repository.js";
import type { MemuPluginConfig, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";

export function createCoreUpsertTool(repo: CoreMemoryRepository, config: MemuPluginConfig, toolCtx?: PluginHookContext) {
  return {
    name: "memory_core_upsert",
    description: "Store or update a durable personal fact about the user in Core Memory. " +
      "ONLY use this for stable personal attributes: identity, preferences, goals, constraints, relationships, work background, skills, habits. " +
      "Do NOT use for: domain knowledge, study notes, law/regulation text, session tasks, debugging context, temporary role assignments, or time-specific information.",
    parameters: {
      type: "object" as const,
      properties: {
        category: { type: "string" as const, description: "Core memory category (identity | preferences | goals | constraints | relationships | general)" },
        key: { type: "string" as const, description: "Core memory key (for example: preferences.editor, identity.name, goals.primary)" },
        value: { type: "string" as const, description: "Core memory value — concise personal fact, plain language, no bullet lists, no citations" },
        importance: { type: "number" as const, description: "Optional importance score (0-10)" },
        provenance: { type: "string" as const, description: "Optional provenance/source label" },
        validUntil: { type: "string" as const, description: "Optional expiry timestamp (ISO 8601). Use for temporary facts (e.g. active projects, short-term goals)." },
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
