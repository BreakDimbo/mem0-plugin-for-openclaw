// ============================================================================
// Smart Router Hook (before_model_resolve)
// Routes queries to different models based on complexity tier
// ============================================================================

import type { UnifiedIntentClassifier } from "../classifier.js";
import type { MemuPluginConfig, ClassificationResult } from "../types.js";
import type { InboundMessageCache } from "../inbound-cache.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

type BeforeModelResolveEvent = {
  prompt?: string;
  messages?: Array<{ role: string; content: unknown }>;
};

type BeforeModelResolveContext = {
  channelId?: string;
  sessionId?: string;
};

type BeforeModelResolveResult = {
  modelOverride?: string;
  providerOverride?: string;
};

/**
 * Extract text from message content (handles string or structured content)
 */
function extractTextBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
    )
    .map((b) => b.text)
    .join("\n");
}

/**
 * Extract senderId from prompt (format: "[user:xxx]" or "From: xxx")
 */
function extractSenderId(prompt: string): string | undefined {
  const match = prompt.match(/\[user:([^\]]+)\]/) || prompt.match(/From:\s*(\S+)/);
  return match?.[1];
}

export function createSmartRouterHook(
  classifier: UnifiedIntentClassifier | undefined,
  inbound: InboundMessageCache,
  config: MemuPluginConfig,
  logger: Logger,
): (event: BeforeModelResolveEvent, ctx: BeforeModelResolveContext) => Promise<BeforeModelResolveResult | undefined> {
  return async (event, ctx) => {
    // Skip if smart router or classifier is disabled
    if (!config.smartRouter.enabled || !classifier) {
      return;
    }

    // Extract query from event
    let query = "";
    if (event.messages) {
      const lastUser = event.messages.filter((m) => m.role === "user").slice(-1)[0];
      query = extractTextBlocks(lastUser?.content);
    }
    if (!query && event.prompt) {
      query = event.prompt;
    }
    query = query.trim();

    if (!query || query.length < 2) {
      return;
    }

    // Try to get cached classification first (from message_received or recall hook)
    const senderId = event.prompt ? extractSenderId(event.prompt) : undefined;
    let classification: ClassificationResult | undefined;

    if (ctx.channelId && senderId) {
      classification = await inbound.getClassification(ctx.channelId, senderId);
    }

    // If no cached classification, run classifier
    if (!classification) {
      classification = await classifier.classify(query);
      // Cache the result for later hooks
      if (ctx.channelId && senderId) {
        inbound.setClassification(ctx.channelId, senderId, classification).catch(() => {});
      }
    }

    // Resolve model based on tier
    const tierModels = config.smartRouter.tierModels;
    const modelOverride = tierModels?.[classification.tier];

    if (modelOverride) {
      logger.info(`smart-router: tier=${classification.tier} queryType=${classification.queryType} → model=${modelOverride}`);

      // Parse provider/model if format is "provider/model"
      if (modelOverride.includes("/")) {
        const [provider, model] = modelOverride.split("/", 2);
        return { providerOverride: provider, modelOverride: model };
      }

      return { modelOverride };
    }

    // No override configured for this tier, use default model
    logger.info(`smart-router: tier=${classification.tier} queryType=${classification.queryType} → default model`);
    return;
  };
}
