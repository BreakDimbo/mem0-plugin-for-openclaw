// ============================================================================
// Hook: agent_end — unified capture of user messages for memorization
// Extracts multi-turn conversation (up to n recent user/assistant messages)
// and routes to CandidateQueue for async processing with LLM gate.
// ============================================================================

import { createHash } from "node:crypto";
import type { OutboxWorker } from "../outbox.js";
import type { LRUCache } from "../cache.js";
import type { Metrics } from "../metrics.js";
import type { MarkdownSync } from "../sync.js";
import type { MemuPluginConfig, MemuMemoryRecord, PluginHookContext, ClassificationResult, ConversationMessage } from "../types.js";
import { buildDynamicScope } from "../types.js";
import { shouldCapture } from "../security.js";
import type { CoreMemoryRepository } from "../core-repository.js";
import { extractCoreProposal, type CoreProposalQueue } from "../core-proposals.js";
import { buildFreeTextMetadata, trigramSimilarity } from "../metadata.js";
import type { CandidateQueue } from "../candidate-queue.js";
import type { InboundMessageCache } from "../inbound-cache.js";
import { judgeCandidates } from "../core-admission.js";
import { stripInjectedBlocks } from "./utils.js";
import type { CaptureDedupStore } from "../capture-dedup-store.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

// Patterns indicating system/internal messages to skip
const SKIP_PREFIXES = ["[system]", "[tool_result]", "<system", "```tool", "<relevant-memories>"];
const LOW_SIGNAL_PATTERNS = [
  /^\s*(ok|okay|好的|嗯|行|收到|知道了|谢谢|thanks?)\s*[.!。!]*\s*$/i,
  /\b(today|tomorrow|tonight|this morning|this afternoon|this evening)\b/i,
  /\b明天\b|\b今天\b|\b今晚\b/,
  /\btest(ing)?\b|\bdebug\b|\boutbox\b|\bmemu\b/i,
  /测试|调试|联调|修复/,
  // Heartbeat / system-health messages — no durable user facts
  /HEARTBEAT/i,
  /心跳检查|无紧急事项/,
  // Timestamp-only messages — current time has no long-term value
  /\bThe current time is (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
  /\bThe user requested the system to read\b/i,
];

function isSystemFragment(text: string): boolean {
  const lower = text.trimStart().toLowerCase();
  return SKIP_PREFIXES.some((p) => lower.startsWith(p));
}

function isInjectedMemory(text: string): boolean {
  return text.includes("<relevant-memories>") || text.includes("</relevant-memories>") ||
         text.includes("<core-memory>") || text.includes("</core-memory>");
}

function isLowSignalUserText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}


function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const rec = asRecord(block);
      if (!rec) return "";
      if (rec.type !== "text") return "";
      return typeof rec.text === "string" ? rec.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

// Extract sender ID from a message object
function extractSenderIdFromMessage(msg: unknown): string {
  const rec = asRecord(msg);
  if (!rec) return "";
  const sender = rec.sender ?? rec.sender_id ?? rec.senderId;
  return typeof sender === "string" ? sender : "";
}

type ExtractedConversationEntry = {
  role: "user" | "assistant";
  content: string;
  senderId?: string;
};

/**
 * Extract multi-turn conversation messages from event.messages.
 * - Only extracts user/assistant roles
 * - Strips injected <relevant-memories> and <core-memory> blocks
 * - Returns up to maxTurns most recent messages
 */
function extractConversationMessages(
  event: { messages?: unknown[] },
  maxTurns: number,
  logger: Logger,
): { messages: ConversationMessage[]; senderId: string } {
  const entries: ExtractedConversationEntry[] = [];

  if (!event.messages || !Array.isArray(event.messages)) {
    return { messages: [], senderId: "" };
  }

  for (const msg of event.messages) {
    const rec = asRecord(msg);
    if (!rec) continue;

    const role = rec.role as string;
    if (role !== "user" && role !== "assistant") continue;

    const rawContent = extractMessageText(rec.content).trim();
    if (!rawContent) continue;

    const cleaned = stripInjectedBlocks(rawContent);
    if (!cleaned) continue;
    if (isInjectedMemory(cleaned)) continue;
    if (isSystemFragment(cleaned)) continue;

    entries.push({
      role: role as "user" | "assistant",
      content: cleaned,
      senderId: role === "user" ? extractSenderIdFromMessage(msg) : undefined,
    });
  }

  const userIndexes = entries
    .map((entry, index) => (entry.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (userIndexes.length === 0) {
    return { messages: [], senderId: "" };
  }

  const effectiveTurns = Math.max(1, maxTurns);
  const startIndex = userIndexes.length > effectiveTurns
    ? userIndexes[userIndexes.length - effectiveTurns]
    : 0;
  const selected = entries.slice(startIndex);
  const senderId = [...selected].reverse().find((entry) => entry.role === "user" && entry.senderId)?.senderId ?? "";
  const messages = selected.map(({ role, content }) => ({ role, content }));

  logger.info(`capture-hook: extracted ${messages.length} conversation messages (${Math.min(userIndexes.length, effectiveTurns)} turns)`);
  return { messages, senderId };
}

function shouldSkipLlmGate(classification: ClassificationResult | undefined): boolean {
  return !!classification && (
    classification.queryType === "code" ||
    classification.queryType === "debug" ||
    classification.queryType === "greeting" ||
    classification.captureHint === "light"
  );
}

async function maybeExtractCoreMemory(
  text: string,
  scope: ReturnType<typeof buildDynamicScope>,
  classification: ClassificationResult | undefined,
  config: MemuPluginConfig,
  coreRepo: CoreMemoryRepository,
  proposalQueue: CoreProposalQueue,
  logger: Logger,
): Promise<void> {
  if (!config.core.enabled || !config.core.autoExtractProposals || !text) return;

  const draft = extractCoreProposal(text, scope);
  if (draft) {
    if (config.core.humanReviewRequired) {
      proposalQueue.enqueue(draft);
    } else {
      await coreRepo.upsert(scope, {
        key: draft.key,
        value: draft.value,
        source: "capture-direct",
        metadata: { reason: draft.reason, proposal_text: draft.text },
      });
    }
    return;
  }

  if (!config.core.llmGate.enabled || shouldSkipLlmGate(classification)) return;

  const result = (await judgeCandidates([text], config.core.llmGate, logger)).find(
    (candidate) => candidate.index === 1 && candidate.verdict === "core" && candidate.key && candidate.value,
  );
  if (!result?.key || !result.value) return;

  if (config.core.humanReviewRequired) {
    proposalQueue.enqueue({
      category: result.key.split(".")[0] || "general",
      text,
      key: result.key,
      value: result.value,
      reason: result.reason || "llm-gate",
      scope,
    });
    return;
  }

  await coreRepo.upsert(scope, {
    key: result.key,
    value: result.value,
    source: "capture-direct-llm-gate",
    metadata: { reason: result.reason, original_text: text },
  });
}

export function createCaptureHook(
  outbox: OutboxWorker,
  coreRepo: CoreMemoryRepository,
  proposalQueue: CoreProposalQueue,
  cache: LRUCache<MemuMemoryRecord[]>,
  config: MemuPluginConfig,
  logger: Logger,
  metrics: Metrics,
  sync: MarkdownSync,
  candidateQueue?: CandidateQueue,
  inbound?: InboundMessageCache,
  dedupStore?: CaptureDedupStore,
) {
  return async (event: { messages?: unknown[]; prompt?: string; success?: boolean }, ctx: PluginHookContext) => {
    logger.info("capture-hook: agent_end triggered");
    if (!config.capture.enabled) return;
    if ("success" in event && event.success === false) {
      logger.info("capture-hook: skipped unsuccessful agent_end event");
      return;
    }

    // Register agent workspace for sync
    if (ctx.agentId && ctx.workspaceDir) {
      sync.registerAgent(ctx.agentId, ctx.workspaceDir);
    }

    // Extract multi-turn conversation from event.messages
    const { messages, senderId } = extractConversationMessages(event, config.capture.maxConversationTurns, logger);

    if (messages.length === 0) {
      logger.info(`capture-hook: no conversation messages extracted`);
      return;
    }

    // Get classification from inbound cache (set by recall hook)
    let classification: ClassificationResult | undefined;
    if (inbound && ctx.channelId && senderId) {
      classification = await inbound.getClassification(ctx.channelId, senderId);
    }

    // Skip capture entirely if captureHint is "skip"
    if (classification?.captureHint === "skip") {
      logger.info(`capture-hook: skipping (captureHint=skip, queryType=${classification.queryType})`);
      return;
    }

    let scope: ReturnType<typeof buildDynamicScope>;
    try {
      scope = buildDynamicScope(config.scope, ctx);
    } catch (err) {
      logger.warn(`capture-hook: invalid scope, skipping capture: ${String(err)}`);
      return;
    }
    metrics.captureTotal++;

    // Get the last user message for validation
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
    const lastUserText = lastUserMsg?.content ?? "";

    // Filter: length + injection + sensitive checks on last user message
    const captureCheck = shouldCapture(lastUserText, config.capture.minChars, config.capture.maxChars);
    if (!captureCheck.allowed) {
      logger.info(`capture-hook: filtered (shouldCapture failed: ${captureCheck.reason})`);
      metrics.captureFiltered++;
      return;
    }

    // Filter: low-signal chatter
    if (isLowSignalUserText(lastUserText)) {
      logger.info(`capture-hook: filtered (low signal)`);
      metrics.captureFiltered++;
      return;
    }

    // Persistent cross-session dedup: skip if identical content was captured before
    if (dedupStore) {
      const scopeKey = `${scope.userId}::${scope.agentId}`;
      const contentHash = createHash("sha256").update(lastUserText.trim().toLowerCase()).digest("hex").slice(0, 16);
      if (await dedupStore.has(scopeKey, contentHash)) {
        logger.info(`capture-hook: filtered (persistent-dedup hash=${contentHash})`);
        metrics.captureDeduped++;
        return;
      }
      await dedupStore.add(scopeKey, contentHash);
    }

    // CandidateQueue path (preferred): enqueue for async batch processing
    if (config.capture.candidateQueue.enabled && candidateQueue) {
      const metadata = classification ? { classification } : undefined;
      candidateQueue.enqueue(messages, scope, metadata);
      metrics.captureCaptured++;
      logger.info(`capture-hook: enqueued ${messages.length} messages to candidateQueue`);

      // Ensure timer is started in this process
      candidateQueue.start().catch(() => {});

      // Schedule sync after capture
      sync.scheduleSync(scope.agentId);
      return;
    }

    // Direct outbox path (legacy, when candidateQueue disabled)
    const isDupe = checkDedup(lastUserText, scope, cache, config.capture.dedupeThreshold);
    if (isDupe) {
      metrics.captureDeduped++;
      logger.info(`capture-hook: filtered (duplicate)`);
      return;
    }

    await maybeExtractCoreMemory(lastUserText, scope, classification, config, coreRepo, proposalQueue, logger);

    outbox.enqueue(
      messages,
      scope,
      buildFreeTextMetadata(lastUserText, scope, {
        captureKind: "auto",
      }),
    );
    metrics.captureCaptured++;
    logger.info(`capture-hook: enqueued ${messages.length} messages to outbox`);

    sync.scheduleSync(scope.agentId);
  };
}

// Track recently captured texts for dedup (module-level, survives across hook invocations)
const recentCapturesByScope = new Map<string, string[]>();
const MAX_RECENT_CAPTURES = 50;
const MAX_DEDUP_SCOPES = 100; // cap map size to prevent unbounded growth in long-running processes

function checkDedup(text: string, scope: { userId: string; agentId: string }, _cache: LRUCache<MemuMemoryRecord[]>, threshold: number): boolean {
  if (threshold >= 1.0) return false; // dedup disabled

  const scopeKey = `${scope.userId}::${scope.agentId}`;
  const recentCaptures = recentCapturesByScope.get(scopeKey) ?? [];

  // Check against recently captured texts
  for (const recent of recentCaptures) {
    if (trigramSimilarity(text, recent) >= threshold) {
      return true;
    }
  }

  // Track this text for future dedup
  recentCaptures.push(text);
  if (recentCaptures.length > MAX_RECENT_CAPTURES) {
    recentCaptures.splice(0, recentCaptures.length - MAX_RECENT_CAPTURES);
  }
  // Evict oldest scope entry if map is full
  if (!recentCapturesByScope.has(scopeKey) && recentCapturesByScope.size >= MAX_DEDUP_SCOPES) {
    const oldestKey = recentCapturesByScope.keys().next().value;
    if (oldestKey !== undefined) recentCapturesByScope.delete(oldestKey);
  }
  recentCapturesByScope.set(scopeKey, recentCaptures);

  return false;
}
