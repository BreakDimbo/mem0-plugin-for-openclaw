import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import type { FreeTextMemoryMetadata, MemoryScope, MemuMemoryRecord, MemuPluginConfig } from "../../types.js";
import type { FreeTextBackend, FreeTextBackendStatus, FreeTextForgetOptions, FreeTextSearchOptions, FreeTextStoreOptions, ConversationMessage } from "./base.js";
import { matchesMetadataFilters } from "../../metadata.js";
import { isGoogleProvider, normalizeMem0LlmConfig } from "../../llm-config.js";

// Patterns matching records that must be suppressed at recall time.
// Two sources:
//   A) mem0-internal system strings erroneously extracted as "facts"
//   B) Operational/status noise — synced from LOW_SIGNAL_PATTERNS (capture.ts)
//      and KNOWLEDGE_DUMP_PATTERNS (security.ts) so Layer 2 mirrors Layer 1.
//      Historical records written before Layer 1 existed are caught here.
const GARBAGE_MEMORY_PATTERNS: RegExp[] = [
  // ── A: mem0 system placeholder strings ──────────────────────────────────
  /^new\s+fact\s+added\.?$/i,
  /^new\s+retrieved\s+fact\s+\d+\.?$/i,
  /^add\s+new\s+retrieved\s+facts?\s+to\s+(the\s+)?memory\.?$/i,
  /^new\s+retrieved\s+facts?\s+are\s+mentioned/i,

  // ── B: Operational noise (synced from Layer 1) ───────────────────────────
  /HEARTBEAT/i,                                // English heartbeat messages
  /心跳检查|无紧急事项/,                        // Chinese heartbeat / status-ok phrases
  /\bThe current time is (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
  /\bThe user requested the system to read\b/i,

  // ── C: Structured report null-value lines ────────────────────────────────
  // Matches items like "4. 模式推广：无需要推广的模式" and
  // "2. 错误 - 重复错误：无需要解决的重复错误" — periodic health check
  // templates where each entry reports "nothing to do".
  /无需要.{1,30}的/,
];

function expandTilde(p: string): string {
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  if (p === "~") return homedir();
  return p;
}

type Logger = { info(msg: string): void; warn(msg: string): void };

type Mem0SearchItem = {
  id?: string;
  memory?: string;
  score?: number;
  categories?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

type Mem0Provider = {
  add(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>): Promise<{ results?: Array<{ id?: string; event?: string }> }>;
  search(query: string, options: Record<string, unknown>): Promise<Mem0SearchItem[] | { results?: Mem0SearchItem[] }>;
  getAll(options: Record<string, unknown>): Promise<Mem0SearchItem[] | { results?: Mem0SearchItem[] }>;
  delete(memoryId: string): Promise<void>;
};

type Mem0ProviderFactory = () => Promise<Mem0Provider>;

type Mem0LlmConfig = {
  provider: string;
  config: Record<string, unknown>;
};

type JsonCapableLlm = {
  generateResponse(
    messages: Array<{ role: string; content: string | unknown }>,
    responseFormat?: { type: string },
    tools?: unknown[],
  ): Promise<unknown>;
};

const DEFAULT_LONG_TERM_CAPTURE_INSTRUCTIONS = `Extract durable, reusable knowledge from the conversation and store it as self-contained facts.

Prioritize information that can improve future assistance across sessions:
- user profile, preferences, routines, goals, constraints, and relationships
- project context, work context, technical setup, architecture decisions, and operating procedures
- important metrics, benchmarks, limits, thresholds, and configuration choices
- lessons learned, stable conclusions, and repeated patterns

Guidelines:
- write each memory as a standalone factual statement in third person
- prefer concise conclusion sentences over raw dialogue or code
- merge duplicate facts and update stale facts instead of creating noisy variants
- keep long-term knowledge, not one-off chatter or transient coordination
- if the conversation contains a decision, remember both the decision and the reason when useful
- if it contains a metric or configuration value, preserve the exact value
- if it contains an architecture or workflow concept, store the stable summary rather than the entire discussion

Exclude:
- secrets, credentials, tokens, or private identifiers
- temporary acknowledgements, greetings, or filler
- raw code unless the enduring decision or constraint is the actual memory`;

function toPathHref(path: string): string {
  return pathToFileURL(path).href;
}

function normalizeArray<T>(value: T[] | { results?: T[] } | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.results)) return value.results;
  return [];
}

export function sanitizeJsonLikeResponse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  const extracted = extractBalancedJson(trimmed);
  if (extracted) return extracted;

  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractBalancedJson(text: string): string | null {
  const start = text.search(/[\[{]/);
  if (start === -1) return null;

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1).trim();
      }
    }
  }

  return null;
}

function patchLlmGenerateResponse(llm: JsonCapableLlm, stripResponseFormatWhenTools: boolean): void {
  if ((llm.generateResponse as any).__memoryMemuPatched) return;

  const original = llm.generateResponse.bind(llm);
  const wrapped = async (...args: Parameters<JsonCapableLlm["generateResponse"]>) => {
    // Gemini OpenAI-compat endpoint rejects requests that have both response_format and tools.
    // Drop response_format when tools are present so graph extraction works correctly.
    if (stripResponseFormatWhenTools && args[2] && (args[2] as unknown[]).length > 0) {
      args[1] = undefined;
    }
    const response = await original(...args);
    return sanitizeJsonLikeResponse(response);
  };
  (wrapped as any).__memoryMemuPatched = true;
  llm.generateResponse = wrapped;
}

/**
 * Replace mem0's serial per-document LLM reranker with a single batch call.
 *
 * mem0's LLMReranker.rerank() loops over documents and calls generateResponse()
 * once per document — N docs → N LLM calls. We replace it with a single call
 * that asks the LLM to score all documents at once and return a JSON score array.
 *
 * Uses memory.llm (the main LLM instance, already patched, no max_tokens cap)
 * rather than reranker.llm (created with max_tokens=50, too small for batches).
 */
export function patchRerankerBatch(memory: Record<string, unknown>): void {
  const reranker = (memory as any).reranker;
  if (!reranker || typeof reranker.rerank !== "function") return;
  if ((reranker.rerank as any).__memoryMemuBatchPatched) return;

  // Prefer memory.llm — already initialized, patched, and has generous token limits.
  const llm = (memory.llm ?? reranker.llm) as JsonCapableLlm | undefined;
  if (!llm || typeof llm.generateResponse !== "function") return;

  const original = reranker.rerank.bind(reranker) as (
    query: string,
    documents: Array<Record<string, unknown>>,
    topK?: number,
  ) => Promise<Array<Record<string, unknown>>>;

  const batchRerank = async (
    query: string,
    documents: Array<Record<string, unknown>>,
    topK?: number,
  ): Promise<Array<Record<string, unknown>>> => {
    if (documents.length === 0) return documents;
    // Single doc: no batch benefit, use original path
    if (documents.length === 1) return original(query, documents, topK);

    const docLines = documents
      .map((doc, i) => {
        const text =
          typeof doc.memory === "string" ? doc.memory :
          typeof doc.text === "string" ? doc.text :
          typeof doc.content === "string" ? doc.content :
          String(doc);
        return `${i + 1}. "${text.slice(0, 200)}"`;
      })
      .join("\n");

    const prompt =
      `You are a relevance scoring assistant. Score how relevant each document is to the query.\n\n` +
      `Query: "${query.slice(0, 200)}"\n\n` +
      `Documents:\n${docLines}\n\n` +
      `Return ONLY a JSON array of ${documents.length} scores between 0.0 and 1.0, one per document, in order.\n` +
      `Example: [0.9, 0.1, 0.7]`;

    try {
      const response = await llm.generateResponse([{ role: "user", content: prompt }]);
      const raw = typeof response === "string" ? response : String(response ?? "");
      const arrMatch = raw.match(/\[[\s\S]*?\]/);
      if (!arrMatch) throw new Error("no array in response");

      const scores = JSON.parse(arrMatch[0]) as unknown[];
      if (!Array.isArray(scores) || scores.length !== documents.length) {
        throw new Error(`expected ${documents.length} scores, got ${scores.length}`);
      }

      const scored = documents.map((doc, i) => ({
        ...doc,
        rerank_score: Math.min(Math.max(typeof scores[i] === "number" ? (scores[i] as number) : 0.5, 0.0), 1.0),
      }));
      scored.sort((a, b) => (b.rerank_score as number) - (a.rerank_score as number));

      const limit = topK ?? (reranker.config?.top_k as number | undefined);
      return limit ? scored.slice(0, limit) : scored;
    } catch {
      // Fall back to original serial reranker — correctness over speed on error
      return original(query, documents, topK);
    }
  };

  (batchRerank as any).__memoryMemuBatchPatched = true;
  reranker.rerank = batchRerank;
}

function patchOssMemoryLlm(memory: Record<string, unknown>, stripResponseFormatWhenTools = false): void {
  const llm = memory.llm as JsonCapableLlm | undefined;
  if (llm && typeof llm.generateResponse === "function") {
    patchLlmGenerateResponse(llm, stripResponseFormatWhenTools);
  }

  // Also patch graphMemory.structuredLlm — it sends response_format + tools simultaneously,
  // which Gemini's OpenAI-compat endpoint does not support.
  if (stripResponseFormatWhenTools) {
    const graphMemory = (memory as any).graphMemory;
    if (graphMemory) {
      const structuredLlm = graphMemory.structuredLlm as JsonCapableLlm | undefined;
      if (structuredLlm && typeof structuredLlm.generateResponse === "function") {
        patchLlmGenerateResponse(structuredLlm, true);
      }
    }
  }

  // Replace serial per-doc reranker with a single batch LLM call
  patchRerankerBatch(memory);
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function makeOpenAiCompatibleGoogleConfig(source?: Mem0LlmConfig, fallbackApiKey?: string): Mem0LlmConfig {
  const sourceConfig = toRecord(source?.config);
  const apiKey = typeof sourceConfig.apiKey === "string" && sourceConfig.apiKey.trim().length > 0
    ? sourceConfig.apiKey
    : fallbackApiKey;
  return {
    provider: "openai",
    config: {
      ...sourceConfig,
      ...(apiKey ? { apiKey } : {}),
      baseURL: typeof sourceConfig.baseURL === "string" && sourceConfig.baseURL.trim().length > 0
        ? sourceConfig.baseURL
        : "https://generativelanguage.googleapis.com/v1beta/openai",
    },
  };
}

function resolveGraphLlmConfig(
  cfg: MemuPluginConfig["mem0"],
  fallbackApiKey?: string,
): { topLevelLlm?: Mem0LlmConfig; graphStoreLlm?: Mem0LlmConfig } {
  const baseLlm = normalizeMem0LlmConfig(cfg.oss?.llm, fallbackApiKey);
  const graphLlm = normalizeMem0LlmConfig(cfg.oss?.graph_store?.llm ?? baseLlm, fallbackApiKey);
  if (!cfg.enableGraph) {
    return { topLevelLlm: baseLlm, graphStoreLlm: graphLlm };
  }

  if (isGoogleProvider(graphLlm?.provider) || isGoogleProvider(baseLlm?.provider)) {
    const compat = makeOpenAiCompatibleGoogleConfig(graphLlm ?? baseLlm, cfg.apiKey);
    return {
      // mem0 upstream graph path incorrectly reads top-level llm.config, so mirror compat config there.
      topLevelLlm: compat,
      graphStoreLlm: compat,
    };
  }

  return { topLevelLlm: baseLlm, graphStoreLlm: graphLlm };
}

export function resolveOssLlmConfigForTests(
  cfg: MemuPluginConfig["mem0"],
  fallbackApiKey?: string,
): { topLevelLlm?: Mem0LlmConfig; graphStoreLlm?: Mem0LlmConfig } {
  return resolveGraphLlmConfig(cfg, fallbackApiKey);
}

export function effectiveUserId(scope: MemoryScope): string {
  if (!scope.agentId || scope.agentId === "main") return scope.userId;
  return `${scope.userId}:agent:${scope.agentId}`;
}

export class Mem0FreeTextBackend implements FreeTextBackend {
  readonly provider = "mem0";
  private loadedProvider: Mem0Provider | null = null;
  private initPromise: Promise<Mem0Provider> | null = null;

  constructor(
    private readonly config: MemuPluginConfig,
    private readonly logger: Logger,
    private readonly providerFactory?: Mem0ProviderFactory,
  ) {}

  private async createProvider(): Promise<Mem0Provider> {
    const cfg = this.config.mem0;
    if (cfg.mode === "platform") {
      const imported = await import("mem0ai");
      const ClientCtor = (imported as Record<string, unknown>).default as new (opts: Record<string, unknown>) => any;
      const client = new ClientCtor({
        apiKey: cfg.apiKey,
        ...(cfg.orgId ? { org_id: cfg.orgId } : {}),
        ...(cfg.projectId ? { project_id: cfg.projectId } : {}),
      });
      return {
        add: (messages, options) => client.add(messages, options),
        search: async (query, options) => normalizeArray(await client.search(query, options)),
        getAll: async (options) => normalizeArray(await client.getAll(options)),
        delete: (memoryId) => client.delete(memoryId),
      };
    }

    try {
      const imported = await import("mem0ai/oss");
      const MemoryCtor = (imported as Record<string, unknown>).Memory as new (cfg: Record<string, unknown>) => any;
      const resolvedHistoryDbPath = cfg.oss?.historyDbPath ? expandTilde(cfg.oss.historyDbPath) : undefined;
      const { topLevelLlm, graphStoreLlm } = resolveGraphLlmConfig(
        cfg,
        this.config.kimiApiKey ?? this.config.geminiApiKey,
      );
      // Check original providers before resolveGraphLlmConfig converts google→openai
      const stripResponseFormatWhenTools = isGoogleProvider(cfg.oss?.llm?.provider) || isGoogleProvider(cfg.oss?.graph_store?.llm?.provider);
      const graphStoreConfig = cfg.enableGraph && cfg.oss?.graph_store
        ? {
            graphStore: {
              ...cfg.oss.graph_store,
              llm: graphStoreLlm ?? { provider: "openai", config: {} },
            },
          }
        : {};

      // Reranker: use explicit config if set, otherwise auto-derive llm_reranker from the
      // configured LLM. This enables LLM-based relevance scoring during recall without
      // requiring a separate reranker config entry.
      // When llm is not configured (e.g. offline/embeddings-only mode), skip reranker.
      const rerankerConfig: { provider: string; config: Record<string, unknown> } | undefined =
        cfg.oss?.reranker ??
        (topLevelLlm
          ? {
              provider: "llm_reranker",
              config: {
                provider: topLevelLlm.provider,
                model: topLevelLlm.config.model as string ?? "",
                // mem0 reranker config uses snake_case; our llm config uses camelCase apiKey
                ...(topLevelLlm.config.apiKey ? { api_key: topLevelLlm.config.apiKey } : {}),
                temperature: 0.0,
                max_tokens: 50,  // Reranker only needs a short score like "0.85"
              },
            }
          : undefined);

      const memory = new MemoryCtor({
        version: "v1.1",
        ...(cfg.oss?.embedder ? { embedder: cfg.oss.embedder } : {}),
        ...(cfg.oss?.vectorStore ? { vectorStore: cfg.oss.vectorStore } : {}),
        ...(topLevelLlm ? { llm: topLevelLlm } : {}),
        ...(rerankerConfig ? { reranker: rerankerConfig } : {}),
        // Use historyStore config (not top-level historyDbPath) to ensure proper db path resolution
        historyStore: {
          provider: "sqlite",
          config: { historyDbPath: resolvedHistoryDbPath || ":memory:" },
        },
        ...(cfg.enableGraph ? { enableGraph: true } : {}),
        ...graphStoreConfig,
        customPrompt: cfg.customPrompt || DEFAULT_LONG_TERM_CAPTURE_INSTRUCTIONS,
      });
      patchOssMemoryLlm(memory as Record<string, unknown>, stripResponseFormatWhenTools);
      return {
        add: (messages, options) => memory.add(messages, options),
        search: async (query, options) => normalizeArray(await memory.search(query, options)),
        getAll: async (options) => normalizeArray(await memory.getAll(options)),
        delete: (memoryId) => memory.delete(memoryId),
      };
    } catch (err) {
      // Re-throw with helpful message instead of attempting broken fallback path
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to load mem0ai/oss: ${msg}. ` +
        `Ensure mem0ai is installed: npm install mem0ai`
      );
    }
  }

  private async providerInstance(): Promise<Mem0Provider> {
    if (this.loadedProvider) return this.loadedProvider;
    if (!this.initPromise) {
      this.initPromise = (this.providerFactory ? this.providerFactory() : this.createProvider()).then((provider) => {
        this.loadedProvider = provider;
        return provider;
      });
    }
    return this.initPromise;
  }

  private buildBaseMetadata(scope: MemoryScope, captureKind?: string, extra?: Record<string, unknown>): Record<string, unknown> {
    const ttlDays = this.config.mem0.defaultTtlDays ?? 90;
    const expiresAt = ttlDays > 0 ? Date.now() + ttlDays * 86_400_000 : undefined;
    return {
      scope_user_id: scope.userId,
      scope_agent_id: scope.agentId,
      scope_session_key: scope.sessionKey,
      source: "memory-mem0",
      content_kind: "free-text",
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      ...(captureKind ? { capture_kind: captureKind } : {}),
      ...(extra ?? {}),
    };
  }

  private normalizeSearchResults(items: Mem0SearchItem[], scope: MemoryScope): MemuMemoryRecord[] {
    return items
      .map((item) => ({
        id: item.id,
        text: item.memory ?? "",
        category: Array.isArray(item.categories) && item.categories[0] ? item.categories[0] : "mem0",
        score: item.score,
        source: "memu_item" as const,
        scope,
        metadata: item.metadata,
        createdAt: item.created_at ? (Number.isFinite(Date.parse(item.created_at)) ? Date.parse(item.created_at) : undefined) : undefined,
      }))
      .filter((item) => item.text.trim().length > 0);
  }

  private filterResults(items: MemuMemoryRecord[], options?: FreeTextSearchOptions): MemuMemoryRecord[] {
    const now = Date.now();
    let filtered = items;

    // Filter expired items unless caller explicitly requests them
    if (!options?.includeExpired) {
      filtered = filtered.filter((item) => {
        const expiresAt = (item.metadata as Record<string, unknown> | undefined)?.["expires_at"];
        return typeof expiresAt !== "number" || expiresAt > now;
      });
    }

    // Filter mem0-generated garbage strings — these are system-internal phrases
    // that mem0's LLM fact extractor mistakenly promotes to "facts".
    // Always filtered; no option to bypass (they are never valid user facts).
    filtered = filtered.filter((item) => !GARBAGE_MEMORY_PATTERNS.some((p) => p.test(item.text ?? "")));

    // Exclude transient-quality items by default — they are debugging/session context not
    // suitable for long-term injection into future prompts.
    // Exception: if the caller explicitly requests a quality filter (e.g. for admin/debug),
    // let that filter run instead so transient items can be retrieved on demand.
    if (!options?.quality) {
      filtered = filtered.filter((item) => (item.metadata as Record<string, unknown> | undefined)?.["quality"] !== "transient");
    }
    if (options?.category) {
      filtered = filtered.filter((item) => item.category === options.category);
    }
    if (options?.quality || options?.memoryKinds?.length || options?.captureKind) {
      filtered = filtered.filter((item) => matchesMetadataFilters(item.metadata, options));
    }
    return filtered;
  }

  async healthCheck(): Promise<FreeTextBackendStatus> {
    try {
      await this.providerInstance();
      return {
        provider: this.provider,
        mode: this.config.mem0.mode,
        healthy: true,
        detail: "mem0 backend initialized",
      };
    } catch (err) {
      return {
        provider: this.provider,
        mode: this.config.mem0.mode,
        healthy: false,
        detail: String(err),
      };
    }
  }

  async store(messages: ConversationMessage[], scope: MemoryScope, options?: FreeTextStoreOptions): Promise<boolean> {
    if (messages.length === 0) return true;
    try {
      const provider = await this.providerInstance();
      const effectiveUid = effectiveUserId(scope);
      const metadata = this.buildBaseMetadata(
        scope,
        String(options?.metadata?.capture_kind ?? ""),
        options?.metadata as FreeTextMemoryMetadata | undefined,
      );
      const isKimiCoding = this.config.mem0.oss?.llm?.provider === "kimi_coding";
      const addOptions: Record<string, unknown> = this.config.mem0.mode === "open-source"
        ? {
            userId: effectiveUid,
            ...(options?.sessionScoped ? { runId: scope.sessionKey } : {}),
            // kimi_coding handles its own inference; passing infer=false prevents double-inference
            ...(isKimiCoding ? { infer: false } : {}),
            metadata,
          }
        : {
            user_id: effectiveUid,
            ...(options?.sessionScoped ? { run_id: scope.sessionKey } : {}),
            metadata,
            custom_instructions: this.config.mem0.customInstructions || DEFAULT_LONG_TERM_CAPTURE_INSTRUCTIONS,
            ...(this.config.mem0.enableGraph ? { enable_graph: true } : {}),
            output_format: "v1.1",
          };
      const result = await provider.add(messages, addOptions);
      return Array.isArray(result?.results) ? result.results.length > 0 : true;
    } catch (err) {
      this.logger.warn(`mem0-backend: store failed: ${String(err)}`);
      return false;
    }
  }

  async search(query: string, scope: MemoryScope, options?: FreeTextSearchOptions): Promise<MemuMemoryRecord[]> {
    try {
      const provider = await this.providerInstance();
      const effectiveUid = effectiveUserId(scope);
      const longTermOptions: Record<string, unknown> = this.config.mem0.mode === "open-source"
        ? {
            userId: effectiveUid,
            limit: options?.maxItems ?? this.config.mem0.topK,
            threshold: this.config.mem0.searchThreshold,
          }
        : {
            api_version: "v2",
            filters: { user_id: effectiveUid },
            top_k: options?.maxItems ?? this.config.mem0.topK,
            threshold: this.config.mem0.searchThreshold,
            keyword_search: true,
            rerank: true,
          };
      const sessionOptions: Record<string, unknown> = this.config.mem0.mode === "open-source"
        ? {
            userId: effectiveUid,
            runId: scope.sessionKey,
            limit: options?.maxItems ?? this.config.mem0.topK,
            threshold: this.config.mem0.searchThreshold,
          }
        : {
            api_version: "v2",
            filters: { user_id: effectiveUid, run_id: scope.sessionKey },
            top_k: options?.maxItems ?? this.config.mem0.topK,
            threshold: this.config.mem0.searchThreshold,
            keyword_search: true,
            rerank: true,
          };

      const longTerm = this.normalizeSearchResults(normalizeArray(await provider.search(query, longTermOptions)), scope);
      const filteredLongTerm = this.filterResults(longTerm, options);
      if (!options?.includeSessionScope) {
        return filteredLongTerm.slice(0, options?.maxItems ?? filteredLongTerm.length);
      }
      const session = this.normalizeSearchResults(normalizeArray(await provider.search(query, sessionOptions)), scope);
      const filteredSession = this.filterResults(session, options);
      const seen = new Set(filteredLongTerm.map((item) => item.id ?? item.text));
      const combined = [...filteredLongTerm, ...filteredSession.filter((item) => !seen.has(item.id ?? item.text))];
      return combined.slice(0, options?.maxItems ?? combined.length);
    } catch (err) {
      this.logger.warn(`mem0-backend: search failed: ${String(err)}`);
      return [];
    }
  }

  async list(scope: MemoryScope, options?: { limit?: number; includeSessionScope?: boolean }): Promise<MemuMemoryRecord[]> {
    try {
      const provider = await this.providerInstance();
      const effectiveUid = effectiveUserId(scope);
      const longTermOptions: Record<string, unknown> = this.config.mem0.mode === "open-source"
        ? { userId: effectiveUid }
        : { user_id: effectiveUid, page_size: options?.limit ?? 50 };
      const sessionOptions: Record<string, unknown> = this.config.mem0.mode === "open-source"
        ? { userId: effectiveUid, runId: scope.sessionKey }
        : { user_id: effectiveUid, run_id: scope.sessionKey, page_size: options?.limit ?? 50 };
      const longTerm = this.normalizeSearchResults(normalizeArray(await provider.getAll(longTermOptions)), scope);
      const filteredLongTerm = this.filterResults(longTerm);
      if (!options?.includeSessionScope) {
        return filteredLongTerm.slice(0, options?.limit ?? filteredLongTerm.length);
      }
      const session = this.normalizeSearchResults(normalizeArray(await provider.getAll(sessionOptions)), scope);
      const filteredSession = this.filterResults(session);
      const seen = new Set(filteredLongTerm.map((item) => item.id ?? item.text));
      return [...filteredLongTerm, ...filteredSession.filter((item) => !seen.has(item.id ?? item.text))].slice(0, options?.limit ?? Number.MAX_SAFE_INTEGER);
    } catch (err) {
      this.logger.warn(`mem0-backend: list failed: ${String(err)}`);
      return [];
    }
  }

  async forget(scope: MemoryScope, options?: FreeTextForgetOptions) {
    try {
      const provider = await this.providerInstance();
      if (options?.memoryId) {
        try {
          await provider.delete(options.memoryId);
        } catch (deleteErr) {
          // "not found" is idempotent — already deleted is the desired state.
          if (!/not found/i.test(String(deleteErr))) throw deleteErr;
        }
        return { purged_categories: 0, purged_items: 1, purged_resources: 0 };
      }

      // E1: Support query-based batch deletion
      if (options?.query) {
        const matches = await this.search(options.query, scope, { maxItems: 100 });
        // Deduplicate IDs — multiple overlapping queries may return the same item.
        const ids = [...new Set(matches.map((m) => m.id).filter(Boolean) as string[])];
        let deletedCount = 0;
        for (const id of ids) {
          try {
            await provider.delete(id);
            deletedCount++;
          } catch (deleteErr) {
            const msg = String(deleteErr);
            // "not found" is idempotent — the item is already gone, which is the desired state.
            if (/not found/i.test(msg)) {
              deletedCount++;
            } else {
              this.logger.warn(`mem0-backend: failed to delete ${id}: ${msg}`);
            }
          }
        }
        return { purged_categories: 0, purged_items: deletedCount, purged_resources: 0 };
      }

      // OSS/platform delete_all semantics differ; keep Phase 1 conservative.
      return null;
    } catch (err) {
      this.logger.warn(`mem0-backend: forget failed: ${String(err)}`);
      return null;
    }
  }
}
