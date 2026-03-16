// ============================================================================
// Hook: before_prompt_build — inject recalled memories into context
// Query strategy prefers current prompt/messages and only uses sender cache as a
// narrow fallback. We intentionally avoid "latest in channel" behavior.
// ============================================================================

import { LRUCache } from "../cache.js";
import type { InboundMessageCache } from "../inbound-cache.js";
import type { Metrics } from "../metrics.js";
import type { MarkdownSync } from "../sync.js";
import type { CandidateQueue } from "../candidate-queue.js";
import { shouldCapture } from "../security.js";
import type { MemuPluginConfig, MemuMemoryRecord, MemoryScope, PluginHookContext } from "../types.js";
import { buildDynamicScope } from "../types.js";
import { type CoreMemoryRepository, inferTierFromCategory } from "../core-repository.js";
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
  items: Array<{ id: string; category?: string; key: string; value: string; tier?: string; score?: number }>;
  fetchedAt: number;
};

type SessionRelevantCacheEntry = {
  items: MemuMemoryRecord[];
  storedAt: number;
};

type QueryIntent = {
  singleFact: boolean;
  configLike: boolean;
  categoryHints: string[];
};

const SESSION_INJECTION_CACHE = new Map<string, SessionInjectionSnapshot>();
const SESSION_INJECTION_CACHE_LIMIT = 200;
const SESSION_INJECTION_DEDUP_WINDOW_MS = 30_000; // 30s time-window dedup instead of session-wide
const SESSION_CORE_CACHE = new Map<string, SessionCoreCacheEntry>();
const SESSION_CORE_CACHE_TTL_MS = 90 * 1000; // 90s — reduced from 5min to pick up mid-session core updates sooner
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
  if (s.length > 2000) return false;
  // CJK characters are denser — allow 2-char CJK queries
  const hasCJK = /[\u4e00-\u9fff]/.test(s);
  if (s.length < (hasCJK ? 2 : 3)) return false;
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

function isSystemStartupPrompt(text: string): boolean {
  const s = text.trim();
  if (/^A new session was started via\b/i.test(s)) return true;
  if (/Execute your Session Startup Sequence/i.test(s)) return true;
  if (/^Read HEARTBEAT\.md/i.test(s)) return true;
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
    if (unique.size >= 6) break;
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
    ? Math.max(0.30, topScore * 0.40)
    : Math.max(0.15, topScore * 0.28);
  const filtered = items.filter((item, index) => index === 0 || (item.score ?? 0) >= threshold);
  return filtered.length > 0 ? filtered : items;
}

function inferQueryIntent(query: string, queryPartCount: number): QueryIntent {
  const normalized = query.trim().toLowerCase();
  const singleFact = queryPartCount <= 1
    && !/[；;\n]/.test(query)
    && !/(\d+[.、])/.test(query);
  const configLike = /\b(timeout|p95|classifier|route|router|embedding|dim|dimension|cost|cbreset|retrieve|search)\b|层数|架构|参数|配置|超时|维度|费用|分类器|路由/.test(normalized);
  const compact = normalized.replace(/\s+/g, "");
  const categoryHints = new Set<string>();
  if (/(名字|姓名|时区|人格|性格|mbti|身份|来自|timezone|name|personality|profile)/.test(compact)) {
    // both legacy "identity" and FreeTextMemoryKind "profile" may appear as stored categories
    categoryHints.add("identity");
    categoryHints.add("profile");
  }
  if (/(工作内容|职业背景|全职工作|岗位|公司角色|job|career|employer|fulltime)/.test(compact)) {
    categoryHints.add("work");
  }
  if (/(偏好|喜欢|更喜欢|讨厌|表达方式|沟通方式|沟通风格|口味|drink|prefer|preference|style|expression)/.test(compact)) {
    // both legacy "preferences" and FreeTextMemoryKind "preference"
    categoryHints.add("preferences");
    categoryHints.add("preference");
  }
  if (/(目标|探索|方向|计划|想做|项目|goal|exploration|roadmap|project)/.test(compact)) {
    categoryHints.add("goals");
    categoryHints.add("project");
  }
  if (/(原则|规则|约束|默认要求|确认|隐私|禁止|必须|constraint|privacy|rule|approval)/.test(compact)) {
    categoryHints.add("constraints");
    categoryHints.add("constraint");
  }
  if (/(爱人|伴侣|朋友|同事|关系|partner|wife|husband|relationship)/.test(compact)) {
    categoryHints.add("relationships");
    categoryHints.add("relationship");
  }
  if (/(配置|参数|模型|embedding|检索|路由|分类器|延迟|成本|超时|维度|config|setting|model|router|classifier|latency|cost|timeout|dimension)/.test(compact)) {
    categoryHints.add("technical");
  }
  if (/(决策|取舍|为什么采用|为什么关闭|为什么开启|decision|tradeoff)/.test(compact)) {
    categoryHints.add("decision");
  }
  if (/(架构|分层|管线|存储模型|记忆架构|architecture|layer|pipeline)/.test(compact)) {
    categoryHints.add("architecture");
  }
  if (/(经验|教训|复盘|启发|lesson|takeaway|retrospective)/.test(compact)) {
    categoryHints.add("lesson");
  }
  if (/(基准|延迟|吞吐|成本|费用|benchmark|p95|latency|throughput|pricing)/.test(compact)) {
    categoryHints.add("benchmark");
  }
  if (categoryHints.size === 0) categoryHints.add("general");
  return { singleFact, configLike, categoryHints: Array.from(categoryHints) };
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[?？!！。，、；;:："'`·()\[\]【】\-_/]/g, "");
}

// Map Chinese ordinal numerals to Arabic so "第三层" and "第3层" produce the same token.
const CN_NUMERAL_MAP: Record<string, string> = {
  一: "1", 二: "2", 三: "3", 四: "4", 五: "5",
  六: "6", 七: "7", 八: "8", 九: "9", 十: "10",
};
function normalizeOrdinalNumeral(ordinal: string): string {
  return ordinal.replace(/[一二三四五六七八九十]/g, (c) => CN_NUMERAL_MAP[c] ?? c);
}

// Strip instruction prefixes that appear both in benchmark queries (e.g. "请只用一句中文回答：")
// and in real agent prompts. Removing them before matching prevents false focus-query hits.
function stripQueryBoilerplate(query: string): string {
  return query
    .replace(/^(请只用一句中文回答|请用一句中文回答|请用三行中文回答，不要解释|请用三行中文回答不要解释|请回答|请问)[:：]?\s*/g, "")
    .trim();
}

const QUERY_STOP_TERMS = [
  // Only strip pure functional/modal words that carry no search value.
  // Domain terms like "用户", "工作", "偏好" are intentionally kept.
  "什么",
  "多少",
  "如何",
  "怎么",
  "请问",
  "请",
  "只用",
  "一句",
  "中文",
  "回答",
  "谁",
  "哪里",
  "哪个",
  "哪种",
  "哪类",
  "一下",
  "一下子",
  "的是",
  "是什么",
  "是不是",
  "是否",
];

function stripQueryStopTerms(query: string): string {
  let text = stripQueryBoilerplate(query);
  for (const term of QUERY_STOP_TERMS) {
    text = text.replaceAll(term, " ");
  }
  return text.trim();
}

function buildSearchTerms(text: string): string[] {
  const stripped = stripQueryStopTerms(text);
  const normalized = normalizeForMatch(stripped);
  if (!normalized) return [];
  const tokens = new Set<string>();

  for (const word of normalized.match(/[a-z0-9+_-]{2,}/g) ?? []) {
    tokens.add(word);
  }
  // Preserve ordinal tokens like "第1层" / "第3步", normalising Chinese numerals to Arabic
  // so "第三层" and "第3层" produce the same token and can match each other.
  for (const ordinal of stripped.match(/第\s*[0-9一二三四五六七八九十百]+\s*[\u4e00-\u9fff]/g) ?? []) {
    tokens.add(normalizeForMatch(normalizeOrdinalNumeral(ordinal)));
  }
  for (const chunk of normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    tokens.add(chunk);
    for (let i = 0; i <= chunk.length - 2; i += 1) {
      tokens.add(chunk.slice(i, i + 2));
    }
  }

  return Array.from(tokens);
}

function tokenizeDocument(text: string): string[] {
  const normalized = normalizeForMatch(text);
  if (!normalized) return [];
  const tokens: string[] = [];
  for (const word of normalized.match(/[a-z0-9+_-]{2,}/g) ?? []) {
    tokens.push(word);
  }
  // Preserve ordinal tokens like "第1层" / "第3步", normalising Chinese numerals to Arabic.
  for (const ordinal of text.match(/第\s*[0-9一二三四五六七八九十百]+\s*[\u4e00-\u9fff]/g) ?? []) {
    tokens.push(normalizeForMatch(normalizeOrdinalNumeral(ordinal)));
  }
  for (const chunk of normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let size = 2; size <= Math.min(3, chunk.length); size += 1) {
      for (let i = 0; i <= chunk.length - size; i += 1) {
        tokens.push(chunk.slice(i, i + size));
      }
    }
  }
  return tokens;
}

function scoreTokenOverlap(queryTerms: string[], documentTokens: string[]): number {
  if (queryTerms.length === 0 || documentTokens.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const token of documentTokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  const docLen = documentTokens.length;
  let score = 0;
  let hits = 0;
  for (const term of queryTerms) {
    const freq = tf.get(term) ?? 0;
    if (freq <= 0) continue;
    hits += 1;
    const tfNorm = freq / (freq + 1.2 + 0.15 * (docLen / 20));
    score += 1.3 * tfNorm;
  }
  score += (hits / queryTerms.length) * 0.35;
  return score;
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

// shouldSuppressRelevantMemories removed — both memory layers now always
// contribute to injection. The injection budget constraint is the primary limiter.

function buildSessionInjectionKey(scope: MemoryScope, ctx: PluginHookContext, query: string): string {
  const sessionId = typeof ctx.sessionId === "string" && ctx.sessionId.trim() ? ctx.sessionId.trim() : "";
  const queryFingerprint = normalizeForMatch(stripQueryBoilerplate(query)).slice(0, 60);
  return `${scope.sessionKey}::${sessionId || "session-unknown"}::${queryFingerprint}`;
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
  // Only dedup within the time window — after 30s, allow re-injection
  if (Date.now() - snapshot.timestamp > SESSION_INJECTION_DEDUP_WINDOW_MS) return false;
  return snapshot.signature === signature;
}

function scoreCoreCandidate(
  searchQueries: string[],
  item: { category?: string; key: string; value: string; score?: number },
  intent: QueryIntent,
): number {
  if (searchQueries.length === 0) return item.score ?? 0;
  const documentText = `${item.key} ${item.value}`;
  const documentTokens = tokenizeDocument(documentText);
  return Math.max(
    ...searchQueries.map((searchQuery) => {
      const compactQuery = normalizeForMatch(stripQueryBoilerplate(searchQuery));
      const compactFocusQuery = normalizeForMatch(stripQueryStopTerms(searchQuery));
      if (!compactQuery) return 0;
      const compactDocument = normalizeForMatch(documentText);
      if (compactFocusQuery && compactFocusQuery.length >= 2 && compactDocument.includes(compactFocusQuery)) return 1.2;
      if (compactDocument.includes(compactQuery)) return 1;
      const terms = buildSearchTerms(searchQuery);
      const conceptBoost = genericConceptBoost(searchQuery, item.value);
      const overlapScore = scoreTokenOverlap(terms, documentTokens);
      const normalizedValue = normalizeForMatch(item.value);
      const compactnessBoost = normalizedValue.length > 0
        ? Math.max(0, 0.12 - Math.min(0.12, normalizedValue.length / 400))
        : 0;
      const categoryBoost = intent.categoryHints.includes((item.category ?? "general").toLowerCase()) ? 0.12 : 0;
      if (overlapScore === 0 && conceptBoost < 0.8) return 0;
      // Normalize overlapScore into [0, 1) so token-overlap matches never exceed
      // the exact-match tiers (compactQuery=1.0, compactFocusQuery=1.2).
      const normalizedOverlap = overlapScore / (overlapScore + 2.0);
      return Math.min(0.99, normalizedOverlap + conceptBoost * 0.25 + compactnessBoost + categoryBoost);
    }),
  );
}

function trimCoreForInjection<T extends { score?: number }>(items: T[], intent: QueryIntent, queryPartCount: number, topK: number): T[] {
  if (items.length === 0) return items;
  const topScore = items[0]?.score ?? 0;
  const secondScore = items[1]?.score ?? 0;
  const maxItems = intent.singleFact
    ? ((topScore >= 1.2 && topScore - secondScore >= 0.5) ? 1 : Math.min(4, topK))
    : Math.min(topK, 6);
  if (queryPartCount > 1) return items.slice(0, Math.min(maxItems + 2, items.length));
  return items.slice(0, maxItems);
}

function trimRelevantForInjection(items: MemuMemoryRecord[], intent: QueryIntent, queryPartCount: number, topK: number): MemuMemoryRecord[] {
  if (items.length === 0) return items;
  if (intent.configLike) return items.slice(0, Math.min(2, topK));
  const maxItems = Math.min(topK, 4);
  if (queryPartCount > 1) return items.slice(0, Math.min(maxItems + 2, items.length));
  return items.slice(0, maxItems);
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
  candidateQueue?: CandidateQueue,
) {
  return async (event: { prompt?: string; messages?: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }> }, ctx: PluginHookContext) => {
    if (!config.recall.enabled && !config.core.enabled) return;

    if (ctx.agentId && ctx.workspaceDir) {
      sync.registerAgent(ctx.agentId, ctx.workspaceDir);
    }

    // Side-effect: feed user messages to candidateQueue for capture.
    // This is the only hook that fires on all entry paths including
    // `openclaw agent --message` (which doesn't emit message_received
    // or agent_end). CandidateQueue hash-dedup prevents double-processing.
    if (config.capture.enabled && config.capture.candidateQueue.enabled && event.messages) {
      if (!candidateQueue) {
        logger.info("recall-hook: capture side-effect skipped (no candidateQueue ref)");
      } else {
        // Only capture the LAST user message (current turn's input).
        // event.messages contains full session history; enqueuing all of them
        // would repeatedly hash the same first message and dedup everything.
        // Use sanitizePromptQuery to strip timestamps, <relevant-memories>,
        // and other gateway-injected prefixes from the raw message text.
        const capScope = buildDynamicScope(config.scope, ctx);
        let lastUserText = "";
        for (let i = event.messages.length - 1; i >= 0; i--) {
          const msg = event.messages[i];
          if (msg.role !== "user") continue;
          lastUserText = sanitizePromptQuery(extractTextBlocks(msg.content));
          break;
        }
        if (lastUserText) {
          metrics.captureTotal++;
          if (shouldCapture(lastUserText, config.capture.minChars, config.capture.maxChars)) {
            candidateQueue.enqueue(lastUserText, capScope);
            metrics.captureCaptured++;
            logger.info(`recall-hook: enqueued last user message to candidateQueue (${lastUserText.slice(0, 40)}...)`);
            // Ensure timer is started in this process
            candidateQueue.start().catch(() => {});
          } else {
            metrics.captureFiltered++;
          }
        }
      }
    }

    const promptRaw = event.prompt ?? "";
    let query = "";

    // Primary: extract from last user message in conversation history
    if (event.messages) {
      const lastUser = event.messages.filter((m) => m.role === "user").slice(-1)[0];
      query = extractTextBlocks(lastUser?.content);
    }
    query = sanitizePromptQuery(query);

    // If messages yielded a system startup prompt, prefer event.prompt instead
    const promptQuery = sanitizePromptQuery(promptRaw);
    if (isSystemStartupPrompt(query) && promptQuery && !isSystemStartupPrompt(promptQuery)) {
      query = promptQuery;
    }

    const senderId = extractSenderId(promptRaw);
    if (!query && ctx.channelId && senderId) {
      query = (await inbound.getBySender(ctx.channelId, senderId)) ?? "";
      query = sanitizePromptQuery(query);
    }

    if (!query) query = promptQuery || sanitizePromptQuery(promptRaw);
    if (!query || query.length < 2) return;
    if (isSystemStartupPrompt(query)) return;
    // Skip greetings and trivial social phrases — no memory recall needed.
    if (/^(你好|hi|hello|hey|嗨|哈喽|早|晚安|早安|午安|在吗|在不在|嘿|yo)[\s!！。.？?~～]*$/i.test(query.trim())) return;
    const recallQueries = splitRecallQueries(query);
    const searchQueries = recallQueries.length > 0 ? recallQueries : [query];
    const queryIntent = inferQueryIntent(query, searchQueries.length);

    metrics.recallTotal++;
    const start = Date.now();

    try {
      const scope = buildDynamicScope(config.scope, ctx);
      const injectionKey = buildSessionInjectionKey(scope, ctx, query);
      const sessionCacheKey = `${scope.sessionKey}::${(typeof ctx.sessionId === "string" && ctx.sessionId.trim()) ? ctx.sessionId.trim() : "session-unknown"}`;
      let memoryContext = "";
      let filteredMemories: MemuMemoryRecord[] = [];
      if (config.recall.enabled) {
        const cacheKey = LRUCache.buildCacheKey(`${primaryBackend.provider}\0${searchQueries.join("\u241f")}`, scope.sessionKey, config.recall.topK);
        const cached = cache.get(cacheKey);
        const relevantClusterKey = buildRelevantClusterKey(sessionCacheKey, query);
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
        // Always search workspace facts in parallel and merge (instead of fallback-only)
        const workspaceDir = config.recall.workspaceFallback ? resolveWorkspaceDir(scope.agentId, ctx.workspaceDir) : "";
        if (workspaceDir && config.recall.workspaceFallback) {
          const workspaceFacts = await searchWorkspaceFacts(query, scope, workspaceDir, {
            maxItems: config.recall.workspaceFallbackMaxItems,
            maxFiles: config.recall.workspaceFallbackMaxFiles,
          });
          if (workspaceFacts.length > 0) {
            logger.info(`recall-hook: fetched ${workspaceFacts.length} workspace facts for query="${query.slice(0, 60)}..."`);
            filteredMemories = dedupeMemories([...filteredMemories, ...workspaceFacts]);
            filteredMemories = rerankMemoryResults(query, filteredMemories).slice(0, config.recall.topK);
          }
        }
        if (filteredMemories.length > 0) {
          setSessionRelevantCache(relevantClusterKey, filteredMemories);
        }
        filteredMemories = trimRelevantForInjection(filteredMemories, queryIntent, searchQueries.length, config.recall.topK);
      }

      let coreContext = "";
      let alwaysInjectBlock = "";
      let coreMemories: Array<{ id: string; category?: string; key: string; value: string; tier?: string; score?: number }> = [];
      if (config.core.enabled) {
        const cachedCore = getSessionCoreCache(sessionCacheKey);
        let allCoreFacts: Array<{ id: string; category?: string; key: string; value: string; tier?: string; score?: number }>;
        if (cachedCore) {
          allCoreFacts = cachedCore.items;
        } else {
          const coreCandidates = await coreRepo.list(scope, {
            limit: Math.max(config.core.topK * 5, 50),
          });
          allCoreFacts = coreCandidates.map((item) => ({
            id: item.id,
            category: item.category,
            key: item.key,
            value: item.value,
            tier: item.tier,
          }));
          setSessionCoreCache(sessionCacheKey, allCoreFacts);
        }

        // Phase 1: Always-inject pool (profile + general tiers) — no scoring needed
        const alwaysInjectTiers = config.core.alwaysInjectTiers;
        const alwaysInjectPool = allCoreFacts.filter((item) => {
          const tier = item.tier ?? inferTierFromCategory(item.category ?? "general");
          return alwaysInjectTiers.includes(tier as any);
        });

        // Phase 2: Retrieval pool (technical tier) — scoring-based selection
        const retrievalOnlyTiers = config.core.retrievalOnlyTiers;
        const retrievalPool = allCoreFacts
          .filter((item) => {
            const tier = item.tier ?? inferTierFromCategory(item.category ?? "general");
            return retrievalOnlyTiers.includes(tier as any);
          })
          .map((item) => ({
            ...item,
            score: scoreCoreCandidate(searchQueries, item, queryIntent),
          }));

        const selectedRetrieval = trimCoreForInjection(
          selectRelevantCoreMemories(
            dedupeCoreMemories(retrievalPool).slice(0, Math.max(config.core.topK * 2, config.core.topK)),
            searchQueries.length,
          ),
          queryIntent,
          searchQueries.length,
          config.core.topK,
        ).filter((item) => (item.score ?? 0) > 0);

        // Combine: always-inject first, then scored retrieval
        coreMemories = [...alwaysInjectPool, ...selectedRetrieval];

        // Safety cap on always-inject chars to prevent unbounded growth
        let alwaysInjectContext = formatCoreMemoriesContext(alwaysInjectPool as any);
        if (alwaysInjectContext.length > config.core.maxAlwaysInjectChars) {
          alwaysInjectContext = alwaysInjectContext.slice(0, config.core.maxAlwaysInjectChars) + "\n[truncated]</core-memory>";
        }

        // retrievalContext goes through budget with free-text; alwaysInjectContext is prepended separately
        coreContext = formatCoreMemoriesContext(selectedRetrieval as any);
        alwaysInjectBlock = alwaysInjectContext;

        logger.info(`recall-hook: scope user=${scope.userId} agent=${scope.agentId} core=${coreMemories.length} (always=${alwaysInjectPool.length} retrieval=${selectedRetrieval.length})`);
      }

      if (filteredMemories.length > 0) {
        memoryContext = formatMemoriesContext(filteredMemories);
      }

      metrics.recordRecallLatency(Date.now() - start);
      // Budget applies to retrieval core + free-text; always-inject is prepended outside budget
      const budgetedContent = applyInjectionBudget([coreContext, memoryContext], config.recall.injectionBudgetChars);
      const injected = [alwaysInjectBlock, budgetedContent].filter(Boolean).join("\n\n") || "";
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
            return injected.includes(`候选答案 [${tag}]：${escapeForInjection(m.value)}`);
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
