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
import { genericConceptBoost, rerankMemoryResults, tokenizeSemanticQuery } from "../metadata.js";
import { resolveWorkspaceDir, searchWorkspaceFacts } from "../workspace-facts.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

type SessionInjectionSnapshot = {
  signature: string;
  timestamp: number;
};

type SessionCoreCacheEntry = {
  items: Array<{ id: string; category?: string; key: string; value: string; score?: number }>;
  fetchedAt: number;
};

type SessionRelevantCacheEntry = {
  items: MemuMemoryRecord[];
  storedAt: number;
};

const SESSION_INJECTION_CACHE = new Map<string, SessionInjectionSnapshot>();
const SESSION_INJECTION_CACHE_LIMIT = 200;
const SESSION_CORE_CACHE = new Map<string, SessionCoreCacheEntry>();
const SESSION_CORE_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_RELEVANT_CACHE = new Map<string, SessionRelevantCacheEntry>();
const SESSION_RELEVANT_CACHE_TTL_MS = 90 * 1000;

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
  const s = stripPromptLead(text.trim());
  if (s.length < 3 || s.length > 2000) return false;
  if (/^\[reacted with\b/i.test(s)) return false;
  if (/^(sender|sender_id|message_id|chat_id|user_id)$/i.test(s)) return false;
  if (/^system:\s*\[[^\]]+\]/i.test(s)) return false;
  if (/^current time:/i.test(s)) return false;
  if (/^(feishu|slack|telegram|discord|whatsapp|imessage|signal)\[[^\]]*\]\s*(dm|group|channel|\|)/i.test(s)) return false;
  if (isOpaqueIdentifier(s)) return false;
  return /[\u4e00-\u9fffA-Za-z]/.test(s);
}

function isOpaqueIdentifier(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  if (/^(om|ou|on|oc|chat|msg|thread)_[a-z0-9]{8,}$/i.test(s)) return true;
  if (/^[a-f0-9]{16,}$/i.test(s)) return true;
  if (/^[A-Za-z0-9_-]{20,}$/.test(s) && !/[\u4e00-\u9fff]/.test(s)) return true;
  return false;
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

function stripInjectedBlocks(raw: string): string {
  return raw
    .replace(/<core-memory>[\s\S]*?<\/core-memory>/gi, " ")
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/gi, " ")
    .replace(/\[truncated by injection budget\]/gi, " ")
    .trim();
}

function extractLikelyQuestionLine(raw: string): string {
  const lines = raw
    .split("\n")
    .map((line) => stripPromptLead(line.trim()))
    .filter(Boolean)
    .filter((line) => isLikelyQuery(line));
  return lines.slice(-1)[0] ?? "";
}

function stripPromptLead(raw: string): string {
  let current = raw.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = current
      .replace(/^(user|assistant|system)\s*:\s*/i, "")
      .replace(/^system:\s*/i, "")
      .replace(/^sender:\s*/i, "")
      .replace(/^\[[^\]\n]{6,120}\]\s*/g, "")
      .replace(/^(mon|tue|wed|thu|fri|sat|sun)\b[^,\n]{0,40},?\s+\d{4}-\d{2}-\d{2}[^,\n]{0,40}\s*/i, "")
      .replace(/^(mon|tue|wed|thu|fri|sat|sun)\b[^\n]{0,80}gmt[+-]\d+\]?\s*/i, "")
      .replace(/^(feishu|slack|telegram|discord|whatsapp|imessage|signal)[^\n]*\|\s*/i, "")
      .replace(/^current time:[^\n]*\n?/i, "")
      .trim();
    if (next === current) break;
    current = next;
  }
  return current;
}

export function splitRecallQueries(raw: string): string[] {
  const cleaned = sanitizePromptQuery(raw);
  if (!cleaned) return [];

  const direct = cleaned.trim();
  const normalized = direct
    .replace(/^(请只用一句中文回答[:：]?|请用一句中文回答[:：]?|请用三行中文回答，不要解释[:：]?|请回答[:：]?)/, "")
    .trim();

  const numberedMatches = normalized
    .replace(/(?!^)(\d+[.、]|[一二三四五六七八九十]+[、.])\s*/g, "\n$1 ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:\d+[.、]|[一二三四五六七八九十]+[、.])\s*/.test(line))
    .map((line) => line.replace(/^(?:\d+[.、]|[一二三四五六七八九十]+[、.])\s*/, "").trim())
    .filter(Boolean);

  const parts = (numberedMatches.length > 0 ? numberedMatches : normalized.split(/[；;\n]+/))
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => isLikelyQuery(line));

  const unique = new Set<string>();
  const seed = numberedMatches.length > 1 ? parts : [direct, ...parts];
  for (const part of seed) {
    const normalized = part.trim();
    if (!normalized || unique.has(normalized)) continue;
    unique.add(normalized);
    if (unique.size >= 4) break;
  }

  return Array.from(unique);
}

function dedupeMemories(items: MemuMemoryRecord[]): MemuMemoryRecord[] {
  const seen = new Set<string>();
  const output: MemuMemoryRecord[] = [];
  for (const item of items) {
    const key = item.id ?? item.text.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function selectRelevantCoreMemories<T extends { score?: number }>(items: T[], queryPartCount: number): T[] {
  if (items.length <= 1) return items;
  const topScore = items[0]?.score ?? 0;
  if (topScore <= 0) return items;
  const threshold = queryPartCount <= 1
    ? Math.max(0.45, topScore * 0.55)
    : Math.max(0.18, topScore * 0.35);
  const filtered = items.filter((item, index) => index === 0 || (item.score ?? 0) >= threshold);
  return filtered.length > 0 ? filtered : items;
}

function dedupeCoreMemories<T extends { id: string; score?: number }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (!existing || (item.score ?? 0) > (existing.score ?? 0)) {
      byId.set(item.id, item);
    }
  }
  return Array.from(byId.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function shouldSuppressRelevantMemories(
  coreMemories: Array<{ score?: number }>,
  queryPartCount: number,
): boolean {
  if (coreMemories.length === 0) return false;
  const topScore = coreMemories[0]?.score ?? 0;
  if (topScore < 0.6) return false;
  if (queryPartCount <= 1) return true;
  return coreMemories.length >= queryPartCount;
}

function buildSessionInjectionKey(scope: MemoryScope, ctx: PluginHookContext): string {
  const sessionId = typeof ctx.sessionId === "string" && ctx.sessionId.trim() ? ctx.sessionId.trim() : "";
  return `${scope.sessionKey}::${sessionId || "session-unknown"}`;
}

function buildRelevantClusterKey(sessionKey: string, query: string): string {
  const normalized = query
    .toLowerCase()
    .replace(/^(请只用一句中文回答[:：]?|请用一句中文回答[:：]?|请回答[:：]?|请问[:：]?)/, "")
    .replace(/[?？!！。，、；;:："'`·()\[\]【】\s]+/g, "")
    .replace(/用户|什么|多少|如何|怎么|请问|请|只用|一句|中文|回答|偏好|喜欢|爱好|主要|当前|现在|the|what|which|user|prefer|preference/gi, "");
  const cluster = tokenizeSemanticQuery(normalized || query)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2)
    .slice(0, 8)
    .sort()
    .join("|");
  return `${sessionKey}::${cluster || normalized || query.trim().toLowerCase()}`;
}

function getSessionCoreCache(sessionKey: string): SessionCoreCacheEntry | null {
  const entry = SESSION_CORE_CACHE.get(sessionKey);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > SESSION_CORE_CACHE_TTL_MS) {
    SESSION_CORE_CACHE.delete(sessionKey);
    return null;
  }
  return entry;
}

function setSessionCoreCache(
  sessionKey: string,
  items: Array<{ id: string; category?: string; key: string; value: string; score?: number }>,
): void {
  SESSION_CORE_CACHE.set(sessionKey, { items, fetchedAt: Date.now() });
}

function getSessionRelevantCache(cacheKey: string): MemuMemoryRecord[] | null {
  const entry = SESSION_RELEVANT_CACHE.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > SESSION_RELEVANT_CACHE_TTL_MS) {
    SESSION_RELEVANT_CACHE.delete(cacheKey);
    return null;
  }
  return entry.items;
}

function setSessionRelevantCache(cacheKey: string, items: MemuMemoryRecord[]): void {
  SESSION_RELEVANT_CACHE.set(cacheKey, { items, storedAt: Date.now() });
}

function rememberSessionInjection(key: string, signature: string): void {
  SESSION_INJECTION_CACHE.delete(key);
  SESSION_INJECTION_CACHE.set(key, { signature, timestamp: Date.now() });
  if (SESSION_INJECTION_CACHE.size <= SESSION_INJECTION_CACHE_LIMIT) return;
  const oldestKey = SESSION_INJECTION_CACHE.keys().next().value;
  if (oldestKey) SESSION_INJECTION_CACHE.delete(oldestKey);
}

function shouldSkipDuplicateSessionInjection(key: string, signature: string): boolean {
  const snapshot = SESSION_INJECTION_CACHE.get(key);
  if (!snapshot) return false;
  return snapshot.signature === signature;
}

function scoreCoreCandidate(
  searchQueries: string[],
  item: { key: string; value: string; score?: number },
): number {
  if (searchQueries.length === 0) return item.score ?? 0;
  return Math.max(
    ...searchQueries.map((searchQuery) => {
      const q = searchQuery
        .trim()
        .toLowerCase()
        .replace(/[?？!！。，、；;:："'`·()\[\]【】\s]+/g, "")
        .replace(/用户|什么|多少|如何|怎么|请问|请|只用|一句|中文|回答|谁|哪里|哪个|当前|主要|现在/gi, "");
      if (!q) return 0;
      const keyValue = `${item.key} ${item.value}`.toLowerCase();
      const compact = keyValue.replace(/\s+/g, "");
      if (compact.includes(q)) return 1;
      const tokens = tokenizeSemanticQuery(q).filter((token) => token.trim().length >= 2);
      const conceptBoost = genericConceptBoost(searchQuery, item.value);
      if (tokens.length === 0) return conceptBoost;
      let hits = 0;
      for (const token of tokens) {
        if (keyValue.includes(token.toLowerCase())) hits++;
      }
      const lexical = hits / tokens.length;
      if (lexical === 0 && conceptBoost < 0.8) return 0;
      return lexical + conceptBoost * 0.35;
    }),
  );
}

export function sanitizePromptQuery(raw: string): string {
  const s = stripPromptLead(stripInjectedBlocks(raw.trim()));
  if (!s) return "";
  if (isOpaqueIdentifier(s)) return "";
  if (s.startsWith("Read HEARTBEAT.md")) return "";
  if (/^\[reacted with\b/i.test(s)) return "";

  const parsed = maybeJson(s);
  if (parsed !== undefined) {
    const extracted = extractFromObject(parsed);
    if (extracted) return extracted;
  }

  const marker = "Conversation info (untrusted metadata):";
  if (!s.includes(marker)) return extractLikelyQuestionLine(s) || s;

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
    .map((line) => stripPromptLead(line))
    .filter(Boolean)
    .join("\n")
    .trim();

  const parsedStripped = maybeJson(stripped);
  if (parsedStripped !== undefined) {
    const extracted = extractFromObject(parsedStripped);
    if (extracted) return extracted;
  }

  return extractLikelyQuestionLine(stripped) || stripped;
}

export function createRecallHook(
  primaryBackend: FreeTextBackend,
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

    if (event.messages) {
      const lastUser = event.messages.filter((m) => m.role === "user").slice(-1)[0];
      query = extractTextBlocks(lastUser?.content);
    }

    query = sanitizePromptQuery(query);

    const senderId = extractSenderId(promptRaw);
    if (!query && ctx.channelId && senderId) {
      query = (await inbound.getBySender(ctx.channelId, senderId)) ?? "";
      query = sanitizePromptQuery(query);
    }

  if (!query) query = sanitizePromptQuery(promptRaw);
  if (!query || query.length < 3) return;
    const recallQueries = splitRecallQueries(query);
    const searchQueries = recallQueries.length > 0 ? recallQueries : [query];

    metrics.recallTotal++;
    const start = Date.now();

    try {
      const scope = buildDynamicScope(config.scope, ctx);
      const injectionKey = buildSessionInjectionKey(scope, ctx);
      let memoryContext = "";
      let filteredMemories: MemuMemoryRecord[] = [];
      if (config.recall.enabled) {
        const cacheKey = LRUCache.buildCacheKey(`${primaryBackend.provider}\0${searchQueries.join("\u241f")}`, scope.sessionKey, config.recall.topK);
        const cached = cache.get(cacheKey);
        const relevantClusterKey = buildRelevantClusterKey(injectionKey, query);
        const cachedRelevantSelection = getSessionRelevantCache(relevantClusterKey);

        let memories: MemuMemoryRecord[];
        const searchLimit = Math.min(Math.max(config.recall.topK * 3, config.recall.topK + 2), 12);
        if (cachedRelevantSelection) {
          memories = cachedRelevantSelection;
          metrics.recallHits++;
          logger.info(`recall-hook: relevant session-cache hit key=${relevantClusterKey} count=${memories.length}`);
        } else if (cached) {
          memories = cached;
          metrics.recallHits++;
          logger.info(`recall-hook: cache hit key=${cacheKey} count=${memories.length}`);
        } else {
          const primaryResults = await Promise.all(searchQueries.map((searchQuery) => primaryBackend.search(searchQuery, scope, {
            maxItems: searchLimit,
            maxContextChars: config.recall.maxContextChars,
            includeSessionScope: true,
          })));
          memories = dedupeMemories(primaryResults.flat());
          memories = rerankMemoryResults(query, memories).slice(0, config.recall.topK);
          metrics.recallMisses++;
          if (memories.length > 0) cache.set(cacheKey, memories);
          logger.info(`recall-hook: fetched ${memories.length} memories via ${primaryBackend.provider} for ${searchQueries.length} query parts="${query.slice(0, 60)}..."`);
        }

        filteredMemories = memories.filter((m) => m.score === undefined || m.score >= config.recall.scoreThreshold);
        const workspaceDir = config.recall.workspaceFallback ? resolveWorkspaceDir(scope.agentId, ctx.workspaceDir) : "";
        const needsWorkspaceFallback = filteredMemories.length < Math.min(config.recall.topK, 2);
        if (workspaceDir && config.recall.workspaceFallback && needsWorkspaceFallback) {
          const workspaceFacts = await searchWorkspaceFacts(query, scope, workspaceDir, {
            maxItems: config.recall.workspaceFallbackMaxItems,
            maxFiles: config.recall.workspaceFallbackMaxFiles,
          });
          if (workspaceFacts.length > 0) {
            logger.info(`recall-hook: fetched ${workspaceFacts.length} workspace facts for query="${query.slice(0, 60)}..."`);
            filteredMemories = rerankMemoryResults(query, [...filteredMemories, ...workspaceFacts]).slice(0, config.recall.topK);
          }
        }
        if (filteredMemories.length > 0) {
          setSessionRelevantCache(relevantClusterKey, filteredMemories);
        }
      }

      let coreContext = "";
      let coreMemories: Array<{ id: string; category?: string; key: string; value: string; score?: number }> = [];
      if (config.core.enabled) {
        const cachedCore = getSessionCoreCache(injectionKey);
        let corePool: Array<{ id: string; category?: string; key: string; value: string; score?: number }>;
        if (cachedCore) {
          corePool = cachedCore.items.map((item) => ({
            ...item,
            score: scoreCoreCandidate(searchQueries, item),
          }));
        } else {
          const coreCandidates = await coreRepo.list(scope, {
            limit: Math.max(config.core.topK * 5, 50),
          });
          setSessionCoreCache(injectionKey, coreCandidates);
          corePool = coreCandidates.map((item) => ({
            id: item.id,
            category: item.category,
            key: item.key,
            value: item.value,
            score: scoreCoreCandidate(searchQueries, item),
          }));
        }
        coreMemories = selectRelevantCoreMemories(
          dedupeCoreMemories(corePool).slice(0, Math.max(config.core.topK * 2, config.core.topK)),
          searchQueries.length,
        );
        logger.info(`recall-hook: scope user=${scope.userId} agent=${scope.agentId} core=${coreMemories.length}`);
        coreContext = formatCoreMemoriesContext(coreMemories);
      }

      if (filteredMemories.length > 0 && !shouldSuppressRelevantMemories(coreMemories, searchQueries.length)) {
        memoryContext = formatMemoriesContext(filteredMemories);
      }

      metrics.recordRecallLatency(Date.now() - start);
      const injected = applyInjectionBudget([coreContext, memoryContext], config.recall.injectionBudgetChars);
      if (!injected) return;
      const shouldSkipByBlock = shouldSkipDuplicateSessionInjection(injectionKey, injected);
      if (shouldSkipByBlock) {
        logger.info(`recall-hook: skip duplicate injection session=${scope.sessionKey}`);
        return;
      }
      rememberSessionInjection(injectionKey, injected);
      if (config.core.enabled && config.core.touchOnRecall && coreMemories.length > 0) {
        const injectedIds = coreMemories
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
