// ============================================================================
// Hook: before_prompt_build — inject recalled memories into context
// Query strategy prefers current prompt/messages and only uses sender cache as a
// narrow fallback. We intentionally avoid "latest in channel" behavior.
// ============================================================================

import { LRUCache } from "../cache.js";
import type { InboundMessageCache } from "../inbound-cache.js";
import type { Metrics } from "../metrics.js";
import type { MarkdownSync } from "../sync.js";
import type { MemuPluginConfig, MemuMemoryRecord, MemoryScope, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";
import type { CoreMemoryRepository } from "../core-repository.js";
import { applyInjectionBudget, escapeForInjection, formatCoreMemoriesContext, formatMemoriesContext } from "../security.js";
import type { FreeTextBackend } from "../backends/free-text/base.js";
import { compareMemorySets } from "../backends/free-text/compare.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

const PREFERRED_KEYS = ["text", "content", "query", "question", "input", "message"];

function extractTextBlocks(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function maybeJson(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  const payload = fenced?.[1] ?? trimmed;

  if (!payload.startsWith("{") && !payload.startsWith("[")) return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

function isLikelyQuery(text: string): boolean {
  const s = text.trim();
  if (s.length < 3 || s.length > 2000) return false;
  if (/^\[reacted with\b/i.test(s)) return false;
  if (/^(sender|sender_id|message_id|chat_id|user_id)$/i.test(s)) return false;
  return /[\u4e00-\u9fffA-Za-z]/.test(s);
}

function extractFromObject(root: unknown, depth = 0): string {
  if (depth > 6 || root == null) return "";

  if (typeof root === "string") {
    const s = root.trim();
    if (isLikelyQuery(s)) return s;
    const nested = maybeJson(s);
    return nested === undefined ? "" : extractFromObject(nested, depth + 1);
  }

  if (Array.isArray(root)) {
    for (const item of root) {
      const hit = extractFromObject(item, depth + 1);
      if (hit) return hit;
    }
    return "";
  }

  if (typeof root === "object") {
    const obj = root as Record<string, unknown>;

    // Prefer canonical text-like keys.
    for (const key of PREFERRED_KEYS) {
      const val = obj[key];
      const hit = extractFromObject(val, depth + 1);
      if (hit) return hit;
    }

    // Then scan all fields.
    for (const val of Object.values(obj)) {
      const hit = extractFromObject(val, depth + 1);
      if (hit) return hit;
    }
  }

  return "";
}

function extractSenderId(raw: string): string {
  const patterns = [
    /"sender_id"\s*:\s*"([^"]{3,200})"/i,
    /\\"sender_id\\"\s*:\s*\\"([^"\\]{3,200})\\"/i,
    /"from"\s*:\s*"([^"]{3,200})"/i,
  ];

  for (const p of patterns) {
    const m = raw.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return "";
}

function sanitizePromptQuery(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (s.startsWith("Read HEARTBEAT.md")) return "";
  if (/^\[reacted with\b/i.test(s)) return "";

  const parsed = maybeJson(s);
  if (parsed !== undefined) {
    const extracted = extractFromObject(parsed);
    if (extracted) return extracted;
  }

  const marker = "Conversation info (untrusted metadata):";
  if (!s.includes(marker)) return s;

  const stripped = s
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const low = line.toLowerCase();
      return !(
        low.startsWith("conversation info (untrusted metadata):") ||
        low.startsWith("cwd:") ||
        low.startsWith("approval policy:") ||
        low.startsWith("sandbox policy:") ||
        low.startsWith("network access:") ||
        low.startsWith("writable roots:") ||
        low.startsWith("you are")
      );
    })
    .join("\n")
    .trim();

  const parsedStripped = maybeJson(stripped);
  if (parsedStripped !== undefined) {
    const extracted = extractFromObject(parsedStripped);
    if (extracted) return extracted;
  }

  return stripped;
}

export function createRecallHook(
  primaryBackend: FreeTextBackend,
  fallbackBackend: FreeTextBackend | null,
  adapter: { resolveRuntimeScope(ctx?: { agentId?: string; sessionKey?: string; sessionId?: string; workspaceDir?: string }): MemoryScope },
  coreRepo: CoreMemoryRepository,
  cache: LRUCache<MemuMemoryRecord[]>,
  inbound: InboundMessageCache,
  config: MemuPluginConfig,
  logger: Logger,
  metrics: Metrics,
  sync: MarkdownSync,
) {
  return async (event: { prompt?: string; messages?: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }> }, ctx: PluginHookContext) => {
    if (!config.recall.enabled && !config.core.enabled) return;

    if (ctx.agentId && ctx.workspaceDir) {
      sync.registerAgent(ctx.agentId, ctx.workspaceDir);
    }

    const promptRaw = event.prompt ?? "";
    let query = "";

    const senderId = extractSenderId(promptRaw);
    if (ctx.channelId && senderId) {
      query = (await inbound.getBySender(ctx.channelId, senderId)) ?? "";
    }

    if (!query && event.messages) {
      const lastUser = event.messages.filter((m) => m.role === "user").slice(-1)[0];
      query = extractTextBlocks(lastUser?.content);
    }

    query = sanitizePromptQuery(query);
    if (!query) query = sanitizePromptQuery(promptRaw);
    if (!query || query.length < 3) return;

    metrics.recallTotal++;
    const start = Date.now();

    try {
      const scope = buildDynamicScope(config.scope, ctx);
      let memoryContext = "";
      if (config.recall.enabled) {
        const cacheKey = LRUCache.buildCacheKey(`${primaryBackend.provider}\0${query}`, scope.sessionKey, config.recall.topK);
        const cached = cache.get(cacheKey);

        let memories: MemuMemoryRecord[];
        if (cached) {
          memories = cached;
          metrics.recallHits++;
          logger.info(`recall-hook: cache hit key=${cacheKey} count=${memories.length}`);
        } else {
          memories = await primaryBackend.search(query, scope, {
            maxItems: config.recall.topK,
            maxContextChars: config.recall.maxContextChars,
            includeSessionScope: config.backend.freeText.provider === "mem0",
            quality: "durable",
          });
          let fallbackUsed = false;
          if (memories.length === 0 && fallbackBackend) {
            memories = await fallbackBackend.search(query, scope, {
              maxItems: config.recall.topK,
              maxContextChars: config.recall.maxContextChars,
              quality: "durable",
            });
            fallbackUsed = memories.length > 0;
            if (fallbackUsed) {
              metrics.recordRecallFallback();
            }
          }
          if (config.backend.freeText.compareRecall && fallbackBackend) {
            void fallbackBackend.search(query, scope, {
              maxItems: config.recall.topK,
              maxContextChars: config.recall.maxContextChars,
              quality: "durable",
            }).then((shadow) => {
              const comparison = compareMemorySets(memories, shadow);
              metrics.recordRecallCompare(comparison.primaryCount, comparison.shadowCount);
              if (comparison.primaryCount !== comparison.shadowCount) {
                logger.info(
                  `recall-hook: compare primary=${primaryBackend.provider} count=${comparison.primaryCount} shadow=${fallbackBackend.provider} count=${comparison.shadowCount} overlap=${comparison.overlapCount}`,
                );
              }
            }).catch(() => {});
          }
          metrics.recallMisses++;
          if (memories.length > 0) cache.set(cacheKey, memories);
          logger.info(`recall-hook: fetched ${memories.length} memories via ${primaryBackend.provider}${fallbackUsed ? " (fallback)" : ""} for query="${query.slice(0, 60)}..."`);
        }

        const filtered = memories.filter((m) => m.score === undefined || m.score >= config.recall.scoreThreshold);
        memoryContext = filtered.length > 0 ? formatMemoriesContext(filtered) : "";
      }

      let coreContext = "";
      let coreMemoriesForTouch: Array<{ id: string; category?: string; key: string; value: string }> = [];
      if (config.core.enabled) {
        const coreMemories = await coreRepo.list(scope, {
          limit: config.core.topK,
        });
        logger.info(`recall-hook: scope user=${scope.userId} agent=${scope.agentId} core=${coreMemories.length}`);
        coreMemoriesForTouch = coreMemories.map((m) => ({ id: m.id, category: m.category, key: m.key, value: m.value }));
        coreContext = formatCoreMemoriesContext(coreMemories);
      }

      metrics.recordRecallLatency(Date.now() - start);
      const injected = applyInjectionBudget([coreContext, memoryContext], config.recall.injectionBudgetChars);
      if (!injected) return;
      if (config.core.enabled && config.core.touchOnRecall && coreMemoriesForTouch.length > 0) {
        const injectedIds = coreMemoriesForTouch
          .filter((m) => {
            const tag = m.category ? `${escapeForInjection(m.category)}/${escapeForInjection(m.key)}` : escapeForInjection(m.key);
            return injected.includes(`[${tag}] ${escapeForInjection(m.value)}`);
          })
          .map((m) => m.id);
        if (injectedIds.length > 0) {
          coreRepo.touch(scope, { ids: injectedIds, kind: "injected" }).catch(() => {});
        }
      }
      return { prependContext: injected };
    } catch (err) {
      metrics.recallErrors++;
      metrics.recordRecallLatency(Date.now() - start);
      logger.warn(`recall-hook: error: ${String(err)}`);
      return;
    }
  };
}
