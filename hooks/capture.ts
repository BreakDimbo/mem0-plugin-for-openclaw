// ============================================================================
// Hook: agent_end — capture user messages to outbox for async memorization
// Phase 2: dedup via cache, metrics tracking, improved filtering
// ============================================================================

import type { OutboxWorker } from "../outbox.js";
import type { LRUCache } from "../cache.js";
import type { Metrics } from "../metrics.js";
import type { MarkdownSync } from "../sync.js";
import type { MemuPluginConfig, MemuMemoryRecord, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";
import { shouldCapture } from "../security.js";
import type { CoreMemoryRepository } from "../core-repository.js";
import { extractCoreProposal } from "../core-proposals.js";
import type { CoreProposalQueue } from "../core-proposals.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

// Patterns indicating system/internal messages to skip
const SKIP_PREFIXES = ["[system]", "[tool_result]", "<system", "```tool", "<relevant-memories>"];

function isSystemFragment(text: string): boolean {
  const lower = text.trimStart().toLowerCase();
  return SKIP_PREFIXES.some((p) => lower.startsWith(p));
}

function isInjectedMemory(text: string): boolean {
  return text.includes("<relevant-memories>") || text.includes("</relevant-memories>");
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

// Simple text similarity via character trigram overlap
function trigramSimilarity(a: string, b: string): number {
  const trigramsOf = (s: string): Set<string> => {
    const t = new Set<string>();
    const lower = s.toLowerCase();
    for (let i = 0; i <= lower.length - 3; i++) {
      t.add(lower.slice(i, i + 3));
    }
    return t;
  };

  const ta = trigramsOf(a);
  const tb = trigramsOf(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  let overlap = 0;
  for (const t of ta) {
    if (tb.has(t)) overlap++;
  }

  return (2 * overlap) / (ta.size + tb.size);
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
) {
  return async (event: { messages?: unknown[] }, ctx: PluginHookContext) => {
    if (!config.capture.enabled) return;
    if (!event.messages || event.messages.length === 0) return;

    // Register agent workspace for sync
    if (ctx.agentId && ctx.workspaceDir) {
      sync.registerAgent(ctx.agentId, ctx.workspaceDir);
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

      // Dedup: check if this text is too similar to something already cached
      const isDupe = checkDedup(text, cache, config.capture.dedupeThreshold);
      if (isDupe) {
        localDeduped++;
        metrics.captureDeduped++;
        continue;
      }

      candidates.push(text);
    }

    // Take at most maxItemsPerRun (from the end, most recent)
    const toCapture = candidates.slice(-config.capture.maxItemsPerRun);

    for (const text of toCapture) {
      outbox.enqueue(text, scope);
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
      logger.info(`capture-hook: enqueued ${toCapture.length} items (evaluated: ${localEvaluated}, filtered: ${localFiltered}, deduped: ${localDeduped}, core-proposals: ${localProposals})`);
    }
  };
}

// Track recently captured texts for dedup (module-level, survives across hook invocations)
const recentCaptures: string[] = [];
const MAX_RECENT_CAPTURES = 50;

function checkDedup(text: string, cache: LRUCache<MemuMemoryRecord[]>, threshold: number): boolean {
  if (threshold >= 1.0) return false; // dedup disabled

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

  return false;
}
