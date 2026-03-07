// ============================================================================
// Hook: before_agent_start — inject recalled memories into context
// Phase 2: metrics integration, maxContextChars, improved logging
// Aligned with §9.1 recall flow, §13 scope-aware cache keys
// ============================================================================

import type { MemUAdapter } from "../adapter.js";
import { LRUCache } from "../cache.js";
import type { InboundMessageCache } from "../inbound-cache.js";
import type { Metrics } from "../metrics.js";
import type { MarkdownSync } from "../sync.js";
import type { MemuPluginConfig, MemuMemoryRecord, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";
import { formatMemoriesContext } from "../security.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

const PREFERRED_TEXT_KEYS = new Set([
  "text",
  "content",
  "query",
  "question",
  "input",
  "user_input",
  "user_query",
]);

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

function looksLikeHumanQuery(value: string): boolean {
  const s = value.trim();
  if (s.length < 3 || s.length > 2000) return false;
  if (/^[a-z0-9_-]{8,}$/i.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return false;
  if (/^[\[{]/.test(s)) return false;
  if (/^(mon|tue|wed|thu|fri|sat|sun)\b/i.test(s)) return false;
  if (/^\d{4}-\d{2}-\d{2}([ t]\d{2}:\d{2}(:\d{2})?)?/i.test(s)) return false;
  // Prefer natural-language like strings (CJK/letters + spaces/punctuation).
  return /[\u4e00-\u9fffA-Za-z]/.test(s);
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractJsonFromPrompt(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) return tryParseJson(fence[1]);
  const fenceStart = trimmed.match(/```json\s*([\s\S]*)$/i);
  if (fenceStart?.[1]) {
    const partial = fenceStart[1].trim();
    const objStart = partial.indexOf("{");
    const objEnd = partial.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) {
      const sliced = partial.slice(objStart, objEnd + 1);
      const parsed = tryParseJson(sliced);
      if (parsed !== undefined) return parsed;
    }
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return tryParseJson(trimmed);
  return undefined;
}

function pickUserQueryFromObject(root: unknown): string {
  const preferred: string[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown, keyHint?: string) => {
    if (node == null) return;
    if (typeof node === "string") {
      const s = node.trim();
      if (!s || seen.has(s)) return;
      seen.add(s);

      // Some payload fields contain nested JSON strings.
      if ((s.startsWith("{") || s.startsWith("[")) && s.length <= 20000) {
        const nested = tryParseJson(s);
        if (nested !== undefined) walk(nested, keyHint);
      }

      if (!looksLikeHumanQuery(s)) return;
      if (keyHint && PREFERRED_TEXT_KEYS.has(keyHint.toLowerCase())) preferred.push(s);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, keyHint);
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, k);
      }
    }
  };

  walk(root);
  return preferred[0] ?? "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function extractTextFromFeishuContent(content: string): string {
  const parsed = tryParseJson(content);
  if (parsed === undefined) {
    const plain = content.trim();
    return looksLikeHumanQuery(plain) ? plain : "";
  }
  if (typeof parsed === "string") {
    const text = parsed.trim();
    return looksLikeHumanQuery(text) ? text : "";
  }
  const obj = asRecord(parsed);
  if (!obj) return "";

  // Feishu text message content schema (official SDK examples):
  // message.content -> JSON string -> { "text": "..." }
  if (typeof obj.text === "string") {
    const text = obj.text.trim().replace(/@_user_\d+/g, "").trim();
    return looksLikeHumanQuery(text) ? text : "";
  }

  // Feishu post message content: { zh_cn/en_us: { content: [[{tag:"text", text:"..."}]] } }
  for (const localeKey of ["zh_cn", "en_us"]) {
    const locale = asRecord(obj[localeKey]);
    const blocks = locale?.content;
    if (!Array.isArray(blocks)) continue;
    const texts: string[] = [];
    for (const row of blocks) {
      if (!Array.isArray(row)) continue;
      for (const part of row) {
        const rec = asRecord(part);
        if (rec?.tag === "text" && typeof rec.text === "string") {
          const t = rec.text.trim();
          if (t) texts.push(t);
        }
      }
    }
    const merged = texts.join(" ").trim();
    if (looksLikeHumanQuery(merged)) return merged;
  }

  return "";
}

function decodeEscaped(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .trim();
}

function extractFeishuTextFromRaw(raw: string): string {
  const patterns = [
    /"text"\s*:\s*"((?:[^"\\]|\\.){1,2000})"/gi,
    /\\"text\\"\s*:\s*\\"((?:[^"\\]|\\.){1,2000})\\"/gi,
    /"message"\s*:\s*"((?:[^"\\]|\\.){1,2000})"/gi,
    /\\"message\\"\s*:\s*\\"((?:[^"\\]|\\.){1,2000})\\"/gi,
  ];

  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(raw))) {
      const v = decodeEscaped(m[1]);
      if (!looksLikeHumanQuery(v)) continue;
      if (/^(sender|sender_id|message_id|chat_id|user_id)$/i.test(v)) continue;
      return v;
    }
  }
  return "";
}

function extractFeishuQueryFromPayload(raw: string): string {
  const parsed = extractJsonFromPrompt(raw);
  if (parsed === undefined) return "";
  const root = asRecord(parsed);
  if (!root) return "";

  const roots: Record<string, unknown>[] = [root];
  const eventObj = asRecord(root.event);
  if (eventObj) roots.push(eventObj);
  const dataObj = asRecord(root.data);
  if (dataObj) roots.push(dataObj);

  for (const node of roots) {
    const msg = asRecord(node.message);
    if (msg) {
      if (typeof msg.content === "string") {
        const text = extractTextFromFeishuContent(msg.content);
        if (text) return text;
      }
      continue;
    }

    // Some wrappers flatten user text directly as "message": "<text>".
    if (typeof node.message === "string") {
      const text = node.message.trim();
      if (looksLikeHumanQuery(text)) return text;
    }
  }

  const rawText = extractFeishuTextFromRaw(raw);
  if (rawText) return rawText;

  return "";
}

function extractFeishuSenderId(raw: string): string {
  const patterns = [
    /"sender_id"\s*:\s*"([^"]{3,200})"/i,
    /\\"sender_id\\"\s*:\s*\\"([^"\\]{3,200})\\"/i,
    /"from"\s*:\s*"([^"]{3,200})"/i,
  ];
  for (const p of patterns) {
    const m = raw.match(p);
    if (m?.[1]) return decodeEscaped(m[1]).trim();
  }
  return "";
}

function sanitizePromptQuery(prompt: string): string {
  const raw = prompt.trim();
  if (!raw) return "";

  const feishu = extractFeishuQueryFromPayload(raw);
  if (feishu) return feishu;

  const parsed = extractJsonFromPrompt(raw);
  if (parsed !== undefined) {
    const picked = pickUserQueryFromObject(parsed);
    if (picked) return picked;
  }

  // OpenClaw may wrap untrusted metadata into prompt; for retrieval we only want user intent text.
  const marker = "Conversation info (untrusted metadata):";
  if (!raw.includes(marker)) {
    if (raw.startsWith("Read HEARTBEAT.md")) return "";
    return raw;
  }

  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const filtered = lines.filter((line) => {
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
  });

  const stripped = filtered.join("\n").trim();
  const feishuStripped = extractFeishuQueryFromPayload(stripped);
  if (feishuStripped) return feishuStripped;
  const parsedStripped = extractJsonFromPrompt(stripped);
  if (parsedStripped !== undefined) {
    const picked = pickUserQueryFromObject(parsedStripped);
    if (picked) return picked;
  }

  return stripped;
}

function isSuspiciousMetadataQuery(query: string): boolean {
  const q = query.trimStart().toLowerCase();
  return q === "sender" || q.startsWith("```json") || q.startsWith("conversation info (untrusted metadata):") || q.startsWith("{\"message_id\"");
}

export function createRecallHook(
  adapter: MemUAdapter,
  cache: LRUCache<MemuMemoryRecord[]>,
  inbound: InboundMessageCache,
  config: MemuPluginConfig,
  logger: Logger,
  metrics: Metrics,
  sync: MarkdownSync,
) {
  return async (event: { prompt?: string; messages?: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }> }, ctx: PluginHookContext) => {
    if (!config.recall.enabled) return;

    // Register agent workspace for sync
    if (ctx.agentId && ctx.workspaceDir) {
      sync.registerAgent(ctx.agentId, ctx.workspaceDir);
    }

    // Extract query from the latest user input.
    // Prefer inbound message cache from message_received hook (official raw channel text).
    let query = "";
    const promptRaw = event.prompt ?? "";
    const senderId = extractFeishuSenderId(promptRaw);
    if (ctx.channelId && senderId) {
      query = (await inbound.getBySender(ctx.channelId, senderId)) ?? "";
    }
    if (!query && ctx.channelId) {
      query = (await inbound.getLatestByChannel(ctx.channelId)) ?? "";
    }

    // Fallback to in-run messages/prompt parsing if inbound cache misses.
    if (event.messages) {
      const userMsgs = event.messages.filter((m) => m.role === "user");
      const last = userMsgs[userMsgs.length - 1];
      if (!query) query = extractTextBlocks(last?.content);
    }
    // Always sanitize extracted text, because some platforms place metadata wrapper in user content.
    query = sanitizePromptQuery(query);
    if (!query) query = sanitizePromptQuery(promptRaw);

    if (!query || query.length < 3) return;

    if (isSuspiciousMetadataQuery(query)) {
      const promptHead = (event.prompt ?? "").replace(/\s+/g, " ").slice(0, 180);
      const lastUserMsg = (event.messages ?? [])
        .filter((m) => m.role === "user")
        .map((m) => extractTextBlocks(m.content))
        .filter(Boolean)
        .slice(-1)[0] ?? "";
      const lastUserHead = lastUserMsg.replace(/\s+/g, " ").slice(0, 180);
      logger.warn(`recall-hook: suspicious query extracted; promptHead="${promptHead}" lastUserHead="${lastUserHead}"`);
    }

    metrics.recallTotal++;
    const start = Date.now();

    try {
      // Build scope-aware cache key per §13
      const scope = buildDynamicScope(config.scope, ctx);
      const scopeKey = scope.sessionKey;
      const cacheKey = LRUCache.buildCacheKey(query, scopeKey, config.recall.topK);
      const cached = cache.get(cacheKey);

      let memories: MemuMemoryRecord[];
      if (cached) {
        memories = cached;
        metrics.recallHits++;
        logger.info(`recall-hook: cache hit key=${cacheKey} count=${memories.length}`);
      } else {
        memories = await adapter.recall(query, scope, {
          maxItems: config.recall.topK,
          maxContextChars: config.recall.maxContextChars,
        });
        metrics.recallMisses++;
        if (memories.length > 0) {
          cache.set(cacheKey, memories);
        }
        logger.info(`recall-hook: fetched ${memories.length} memories for query="${query.slice(0, 60)}..."`);
      }

      metrics.recordRecallLatency(Date.now() - start);

      // Filter by score threshold
      const filtered = memories.filter(
        (m) => m.score === undefined || m.score >= config.recall.scoreThreshold,
      );

      if (filtered.length === 0) return;

      const formatted = formatMemoriesContext(filtered);
      return { prependContext: formatted };
    } catch (err) {
      metrics.recallErrors++;
      metrics.recordRecallLatency(Date.now() - start);
      logger.warn(`recall-hook: error: ${String(err)}`);
      return;
    }
  };
}
