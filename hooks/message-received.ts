import type { InboundMessageCache } from "../inbound-cache.js";
import type { CandidateQueue } from "../candidate-queue.js";
import type { CoreMemoryRepository } from "../core-repository.js";
import type { MemuPluginConfig } from "../types.js";
import { buildDynamicScope } from "../types.js";
import { shouldCapture } from "../security.js";
import { extractCoreProposal } from "../core-proposals.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

type MessageReceivedEvent = {
  from: string;
  content: string;
};

type MessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
};

// Patterns indicating system/internal messages to skip
const SKIP_PREFIXES = ["[system]", "[tool_result]", "<system", "```tool", "<relevant-memories>"];
const LOW_SIGNAL_PATTERNS = [
  /^\s*(ok|okay|好的|嗯|行|收到|知道了|谢谢|thanks?)\s*[.!。!]*\s*$/i,
  /\b(today|tomorrow|tonight|this morning|this afternoon|this evening)\b/i,
  /\b明天\b|\b今天\b|\b今晚\b/,
  /\btest(ing)?\b|\bdebug\b|\boutbox\b|\bmemu\b/i,
  /测试|调试|联调|修复/,
];

function isSystemFragment(text: string): boolean {
  const lower = text.trimStart().toLowerCase();
  return SKIP_PREFIXES.some((p) => lower.startsWith(p));
}

function isLowSignalUserText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function createMessageReceivedHook(
  cache: InboundMessageCache,
  candidateQueue: CandidateQueue,
  coreRepo: CoreMemoryRepository,
  config: MemuPluginConfig,
  logger: Logger,
) {
  return async (event: MessageReceivedEvent, ctx: MessageContext) => {
    const content = (event.content ?? "").trim();
    if (!content) return;

    // Always cache for recall query extraction
    await cache.set(ctx.channelId, event.from, content);
    logger.info(`message-received: cached inbound text (channel=${ctx.channelId}, from=${event.from})`);

    // -- Capture pipeline: lightweight filter → enqueue candidate --
    if (!config.capture.enabled || !config.capture.candidateQueue.enabled) return;

    // Filter: system fragments
    if (isSystemFragment(content)) return;

    // Filter: length + injection + sensitive checks
    if (!shouldCapture(content, config.capture.minChars, config.capture.maxChars)) return;

    // Filter: low-signal chatter
    if (isLowSignalUserText(content)) return;

    const scope = buildDynamicScope(config.scope, ctx);
    candidateQueue.enqueue(content, scope);

    // Immediate regex core extract for high-confidence patterns (e.g. "我叫X")
    if (config.core.enabled && config.core.autoExtractProposals && !config.core.humanReviewRequired) {
      const draft = extractCoreProposal(content, scope);
      if (draft) {
        const ok = await coreRepo.upsert(scope, {
          key: draft.key,
          value: draft.value,
          source: "capture-realtime",
          metadata: { reason: draft.reason, proposal_text: draft.text },
        });
        if (ok) {
          logger.info(`message-received: immediate core extract key=${draft.key}`);
        }
      }
    }
  };
}
