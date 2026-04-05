// ============================================================================
// Smart Router Hook (before_model_resolve)
// Routes queries to different models based on complexity tier
// ============================================================================

import type { UnifiedIntentClassifier } from "../classifier.js";
import type { MemuPluginConfig, ClassificationResult } from "../types.js";
import type { InboundMessageCache } from "../inbound-cache.js";
import { extractSenderId, extractTextBlocks, stripInjectedBlocks } from "./utils.js";

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


// Per-session override tracking to prevent model-resolution ping-pong loops.
// When the agent detects a model switch it re-triggers before_model_resolve;
// without this guard the hook would re-override every time, causing an
// infinite loop (~8 ms/cycle, 10k+ iterations observed in production).
const SESSION_OVERRIDE_APPLIED = new Map<string, { provider?: string; model: string; ts: number }>();
const SESSION_OVERRIDE_TTL_MS = 60_000; // 1 min — long enough to cover a full request

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

    // --- Ping-pong guard: if we already overrode this session, skip ---
    const sessionKey = ctx.sessionId ?? "__default";
    const prev = SESSION_OVERRIDE_APPLIED.get(sessionKey);
    if (prev) {
      if (Date.now() - prev.ts < SESSION_OVERRIDE_TTL_MS) {
        return;
      }
      // Expired — remove stale entry immediately
      SESSION_OVERRIDE_APPLIED.delete(sessionKey);
    }

    // Extract senderId first (needed for inbound cache lookup)
    const senderId = event.prompt ? extractSenderId(event.prompt) : undefined;

    // Strategy: prioritize inbound cache (raw user message) over event.messages
    // which may contain injected memory content
    let query = "";

    // Try inbound cache first
    if (ctx.channelId && senderId) {
      const cached = await inbound.getBySender(ctx.channelId, senderId);
      if (cached) {
        query = cached.trim();
        logger.info(`smart-router: using inbound cache for query (sender=${senderId})`);
      }
    }

    // Fallback: extract from event.messages (strip injected content)
    if (!query && event.messages) {
      const lastUser = event.messages.filter((m) => m.role === "user").slice(-1)[0];
      const rawContent = extractTextBlocks(lastUser?.content);
      if (rawContent) {
        query = stripInjectedBlocks(rawContent);
      }
    }

    // Last fallback: event.prompt
    if (!query && event.prompt) {
      const stripped = stripInjectedBlocks(event.prompt);
      query = stripped;
    }

    query = query.trim();

    if (!query || query.length < 2) {
      return;
    }

    // Try to get cached classification first (from message_received or recall hook)
    let classification: ClassificationResult | undefined;

    if (ctx.channelId && senderId) {
      classification = await inbound.getClassification(ctx.channelId, senderId);
    }

    // If no cached classification, run classifier
    if (!classification) {
      classification = await classifier.classify(query);
      // Cache the result for later hooks
      if (ctx.channelId && senderId) {
        inbound.setClassification(ctx.channelId, senderId, classification).catch((err) => {
          logger.warn(`smart-router: setClassification failed: ${String(err)}`);
        });
      }
    }

    // Resolve model based on tier
    const tierModels = config.smartRouter.tierModels;
    const modelOverride = tierModels?.[classification.tier];

    if (modelOverride) {
      logger.info(`smart-router: tier=${classification.tier} queryType=${classification.queryType} → model=${modelOverride}`);

      // Record that we've overridden this session so re-triggers are skipped
      let result: BeforeModelResolveResult;

      // Parse provider/model if format is "provider/model"
      if (modelOverride.includes("/")) {
        const [provider, model] = modelOverride.split("/", 2);
        result = { providerOverride: provider, modelOverride: model };
      } else {
        result = { modelOverride };
      }

      SESSION_OVERRIDE_APPLIED.set(sessionKey, {
        provider: result.providerOverride,
        model: result.modelOverride!,
        ts: Date.now(),
      });

      // Evict stale entries — run on every override to prevent unbounded growth
      // even in low-concurrency scenarios. Map iteration is cheap for typical sizes.
      {
        const now = Date.now();
        for (const [k, v] of SESSION_OVERRIDE_APPLIED) {
          if (now - v.ts > SESSION_OVERRIDE_TTL_MS) SESSION_OVERRIDE_APPLIED.delete(k);
        }
      }

      return result;
    }

    // No override configured for this tier, use default model
    logger.info(`smart-router: tier=${classification.tier} queryType=${classification.queryType} → default model`);
    return;
  };
}
