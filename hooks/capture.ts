// ============================================================================
// Hook: agent_end — capture user messages to outbox for async memorization
// Phase 2: dedup via cache, metrics tracking, improved filtering
// ============================================================================

import type { OutboxWorker } from "../outbox.js";
import type { LRUCache } from "../cache.js";
import type { Metrics } from "../metrics.js";
import type { MarkdownSync } from "../sync.js";
import type { MemuPluginConfig, MemuMemoryRecord, PluginHookContext, ClassificationResult } from "../types.js";
import { buildDynamicScope } from "../types.js";
import { shouldCapture } from "../security.js";
import type { CoreMemoryRepository } from "../core-repository.js";
import { extractCoreProposal } from "../core-proposals.js";
import type { CoreProposalQueue } from "../core-proposals.js";
import { buildFreeTextMetadata, trigramSimilarity } from "../metadata.js";
import type { CandidateQueue } from "../candidate-queue.js";
import type { InboundMessageCache } from "../inbound-cache.js";
import { sanitizePromptQuery } from "./recall.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

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

function isInjectedMemory(text: string): boolean {
  return text.includes("<relevant-memories>") || text.includes("</relevant-memories>");
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

function extractUserTextFromAgentEndMessage(msg: unknown): string {
  const rec = asRecord(msg);
  if (!rec) return "";
  if (rec.role !== "user") return "";
  return extractMessageText(rec.content).trim();
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
) {
  // Helper to extract sender ID from an event message
  const extractSenderId = (msg: unknown): string => {
    const rec = asRecord(msg);
    if (!rec) return "";
    const sender = rec.sender ?? rec.sender_id ?? rec.senderId;
    return typeof sender === "string" ? sender : "";
  };

  return async (event: { messages?: unknown[] }, ctx: PluginHookContext) => {
    if (!config.capture.enabled) return;
    if (!event.messages || event.messages.length === 0) return;

    // Register agent workspace for sync
    if (ctx.agentId && ctx.workspaceDir) {
      sync.registerAgent(ctx.agentId, ctx.workspaceDir);
    }

    // Try to get classification from inbound cache (set by recall hook)
    let classification: ClassificationResult | undefined;
    if (inbound && ctx.channelId) {
      // Try to find sender ID from first user message
      for (const msg of event.messages) {
        const senderId = extractSenderId(msg);
        if (senderId) {
          classification = await inbound.getClassification(ctx.channelId, senderId);
          break;
        }
      }
    }

    // Skip capture entirely if captureHint is "skip"
    if (classification?.captureHint === "skip") {
      logger.info(`capture-hook: skipping (captureHint=skip, queryType=${classification.queryType})`);
      return;
    }

    // When CandidateQueue is active, forward user messages to it as a fallback.
    // The message_received hook is the primary feeder, but some entry points
    // (e.g. `openclaw agent --message`) don't emit message_received events.
    // CandidateQueue's hash-based dedup ensures no double-processing.
    if (config.capture.candidateQueue.enabled && candidateQueue) {
      const scope = buildDynamicScope(config.scope, ctx);

      // Only forward the LAST user message (current turn).
      // event.messages may contain full session history; iterating all
      // would re-hash old messages that were already captured.
      let lastUserText = "";
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const raw = extractUserTextFromAgentEndMessage(event.messages[i]);
        if (!raw) continue;
        const text = sanitizePromptQuery(raw);
        if (!text) continue;
        if (isSystemFragment(text) || isInjectedMemory(text)) continue;
        lastUserText = text;
        break;
      }

      if (lastUserText) {
        metrics.captureTotal++;
        if (shouldCapture(lastUserText, config.capture.minChars, config.capture.maxChars) && !isLowSignalUserText(lastUserText)) {
          // Pass classification to CandidateQueue for LLM gate decision
          const metadata = classification ? { classification } : undefined;
          candidateQueue.enqueue(lastUserText, scope, metadata);
          metrics.captureCaptured++;
          logger.info(`capture-hook: forwarded last user message to candidateQueue (fallback)`);
          // Ensure timer is started in this process
          candidateQueue.start().catch(() => {});
        } else {
          metrics.captureFiltered++;
        }
      }
      return;
    }

    const scope = buildDynamicScope(config.scope, ctx);

    // Extract user messages
    const candidates: string[] = [];
    let localFiltered = 0;
    let localDeduped = 0;
    let localEvaluated = 0;
    let localProposals = 0;

    for (const msg of event.messages) {
      const text = extractUserTextFromAgentEndMessage(msg);
      if (!text) continue;

      localEvaluated++;
      metrics.captureTotal++;

      // Filter out system fragments, injected memories
      if (isSystemFragment(text) || isInjectedMemory(text)) {
        localFiltered++;
        metrics.captureFiltered++;
        continue;
      }

      // Length + injection + sensitive checks
      if (!shouldCapture(text, config.capture.minChars, config.capture.maxChars)) {
        localFiltered++;
        metrics.captureFiltered++;
        continue;
      }

      // Filter obvious short-term / low-signal chatter from auto-capture.
      // These can still be stored explicitly via memory_store when needed.
      if (isLowSignalUserText(text)) {
        localFiltered++;
        metrics.captureFiltered++;
        continue;
      }

      // Dedup: check if this text is too similar to something already cached
      const isDupe = checkDedup(text, scope, cache, config.capture.dedupeThreshold);
      if (isDupe) {
        localDeduped++;
        metrics.captureDeduped++;
        continue;
      }

      candidates.push(text);
    }

    // Take at most maxItemsPerRun (from the end, most recent)
    const toCapture = candidates.slice(-3);

    for (const text of toCapture) {
      outbox.enqueue(
        text,
        scope,
        buildFreeTextMetadata(text, scope, {
          captureKind: "auto",
        }),
      );
      metrics.captureCaptured++;

      if (config.core.enabled && config.core.autoExtractProposals) {
        const draft = extractCoreProposal(text, scope);
        if (draft) {
          if (config.core.humanReviewRequired) {
            proposalQueue.enqueue(draft);
            localProposals++;
          } else {
            const ok = await coreRepo.upsert(scope, {
              key: draft.key,
              value: draft.value,
              source: "capture-auto",
              metadata: { reason: draft.reason, proposal_text: draft.text },
            });
            if (ok) localProposals++;
          }
        }
      }
    }

    if (toCapture.length > 0) {
      sync.scheduleSync(scope.agentId);
    }

    if (toCapture.length > 0) {
      logger.info(`capture-hook: enqueued ${toCapture.length} items (evaluated: ${localEvaluated}, filtered: ${localFiltered}, deduped: ${localDeduped}, core-proposals: ${localProposals})`);
    }
  };
}

// Track recently captured texts for dedup (module-level, survives across hook invocations)
const recentCapturesByScope = new Map<string, string[]>();
const MAX_RECENT_CAPTURES = 50;

function checkDedup(text: string, scope: { userId: string; agentId: string }, cache: LRUCache<MemuMemoryRecord[]>, threshold: number): boolean {
  if (threshold >= 1.0) return false; // dedup disabled

  const scopeKey = `${scope.userId}::${scope.agentId}`;
  const recentCaptures = recentCapturesByScope.get(scopeKey) ?? [];

  // Check against recently captured texts
  for (const recent of recentCaptures) {
    if (trigramSimilarity(text, recent) >= threshold) {
      return true;
    }
  }

  // Also check against cached recall results to avoid capturing what was just recalled
  // (The cache stores MemuMemoryRecord[] arrays keyed by query hash — we can't iterate all,
  // but this is handled by the isInjectedMemory filter above)

  // Track this text for future dedup
  recentCaptures.push(text);
  if (recentCaptures.length > MAX_RECENT_CAPTURES) {
    recentCaptures.splice(0, recentCaptures.length - MAX_RECENT_CAPTURES);
  }
  recentCapturesByScope.set(scopeKey, recentCaptures);

  return false;
}
