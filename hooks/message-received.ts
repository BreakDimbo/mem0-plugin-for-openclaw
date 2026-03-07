import type { InboundMessageCache } from "../inbound-cache.js";

type Logger = { info(msg: string): void };

type MessageReceivedEvent = {
  from: string;
  content: string;
};

type MessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
};

export function createMessageReceivedHook(cache: InboundMessageCache, logger: Logger) {
  return async (event: MessageReceivedEvent, ctx: MessageContext) => {
    const content = (event.content ?? "").trim();
    if (!content) return;
    await cache.set(ctx.channelId, event.from, content);
    logger.info(`message-received: cached inbound text (channel=${ctx.channelId}, from=${event.from})`);
  };
}
