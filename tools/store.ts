// ============================================================================
// Tool: memory_store — explicit memory storage
// Phase 2: scope-aware, context param, audit log
// ============================================================================

import type { OutboxWorker } from "../outbox.js";
import type { MemuPluginConfig, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";
import { shouldCapture, audit } from "../security.js";
import { buildFreeTextMetadata } from "../metadata.js";

export function createStoreTool(outbox: OutboxWorker, config: MemuPluginConfig, toolCtx?: PluginHookContext) {
  return {
    name: "memory_store",
    description: "Store a piece of information in long-term memory for future recall. Use this to save important facts, preferences, decisions, or context that should persist across sessions.",
    parameters: {
      type: "object" as const,
      properties: {
        content: { type: "string" as const, description: "The information to memorize" },
        context: { type: "string" as const, description: "Optional context about why this should be remembered" },
      },
      required: ["content"] as const,
    },
    execute: async (_id: string, args: { content: string; context?: string }) => {
      if (!shouldCapture(args.content, config.capture.minChars, config.capture.maxChars)) {
        return { text: "Content rejected: too short, too long, or contains sensitive/suspicious content." };
      }

      const scope = buildDynamicScope(config.scope, toolCtx);
      const text = args.context ? `${args.content} (context: ${args.context})` : args.content;
      const sentBefore = outbox.sent;
      const failedBefore = outbox.failed;
      const metadata = buildFreeTextMetadata(args.content, scope, {
        captureKind: "explicit",
        context: args.context,
      });

      outbox.enqueue(text, scope, metadata);
      await outbox.flush();
      audit("store", scope.userId, scope.agentId, `explicit store: "${text.slice(0, 80)}..."`);

      if (outbox.sent > sentBefore) {
        return { text: "Memory stored successfully." };
      }

      if (outbox.failed > failedBefore) {
        return { text: "Memory storage failed and was moved to dead-letter." };
      }

      return { text: `Memory queued for background retry. (outbox pending: ${outbox.pending})` };
    },
  };
}
