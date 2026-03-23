import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import type { FreeTextMemoryMetadata, MemoryScope, MemuMemoryRecord, MemuPluginConfig } from "../../types.js";
import type { FreeTextBackend, FreeTextBackendStatus, FreeTextForgetOptions, FreeTextSearchOptions, FreeTextStoreOptions, ConversationMessage } from "./base.js";
import { matchesMetadataFilters } from "../../metadata.js";
import { isGoogleProvider, normalizeMem0LlmConfig } from "../../llm-config.js";

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
      const memory = new MemoryCtor({
        version: "v1.1",
        ...(cfg.oss?.embedder ? { embedder: cfg.oss.embedder } : {}),
        ...(cfg.oss?.vectorStore ? { vectorStore: cfg.oss.vectorStore } : {}),
        ...(topLevelLlm ? { llm: topLevelLlm } : {}),
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
    return {
      scope_user_id: scope.userId,
      scope_agent_id: scope.agentId,
      scope_session_key: scope.sessionKey,
      source: "memory-mem0",
      content_kind: "free-text",
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
        createdAt: item.created_at ? Date.parse(item.created_at) : undefined,
      }))
      .filter((item) => item.text.trim().length > 0);
  }

  private filterResults(items: MemuMemoryRecord[], options?: FreeTextSearchOptions): MemuMemoryRecord[] {
    let filtered = items;
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
      const addOptions: Record<string, unknown> = this.config.mem0.mode === "open-source"
        ? {
            userId: effectiveUid,
            ...(options?.sessionScoped ? { runId: scope.sessionKey } : {}),
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
      return Array.isArray(result?.results) ? result.results.length >= 0 : true;
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
        await provider.delete(options.memoryId);
        return { purged_categories: 0, purged_items: 1, purged_resources: 0 };
      }
      // OSS/platform delete_all semantics differ; keep Phase 1 conservative.
      return null;
    } catch (err) {
      this.logger.warn(`mem0-backend: forget failed: ${String(err)}`);
      return null;
    }
  }
}
