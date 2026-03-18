// ============================================================================
// Hook: message_received — cache inbound user messages for recall/capture
// Simplified: only caches raw messages, all capture logic moved to agent_end
// ============================================================================

import type { InboundMessageCache } from "../inbound-cache.js";

type Logger = { info(msg: string): void };

type MessageReceivedEvent = {
  from: string;
  content: string;
};

type MessageContext = {
  channelId: string;
};

/**
 * Creates a lightweight message_received hook that only caches inbound messages.
 *
 * This hook serves as the first touchpoint for user messages, storing the raw
 * content before any processing or memory injection occurs. The cached message
 * is used by:
 * - recall hook: as fallback query source when event.messages extraction fails
 * - capture hook: to get the original user input without injected memory content
 */
export function createMessageReceivedHook(
  cache: InboundMessageCache,
  logger: Logger,
) {
  return async (event: MessageReceivedEvent, ctx: MessageContext) => {
    const content = (event.content ?? "").trim();
    if (!content || !ctx.channelId) return;

    await cache.set(ctx.channelId, event.from, content);
    logger.info(`message-received: cached inbound text (channel=${ctx.channelId}, from=${event.from})`);
  };
}
