// ============================================================================
// Types & Default Configuration for memory-mem0 plugin
// Aligned with 设计文档 v3.0 — full MemoryScope + Phase 2/3 config
// ============================================================================

import {
  getKimiCodingBaseUrl,
  getKimiCodingDefaultModel,
  normalizeChatApiConfig,
  normalizeMem0LlmConfig,
} from "./llm-config.js";

// -- Classification --

export type QueryType = 'greeting' | 'code' | 'debug' | 'factual' | 'preference' | 'planning' | 'open';
export type CaptureHint = 'skip' | 'light' | 'full';

export interface ClassificationResult {
  tier: 'SIMPLE' | 'MEDIUM' | 'COMPLEX' | 'REASONING';
  queryType: QueryType;
  targetCategories: string[];
  captureHint: CaptureHint;
}

export type ClassifierConfig = {
  enabled?: boolean;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  cacheTtlMs?: number;
  cacheMaxSize?: number;
};

export type SmartRouterConfig = {
  enabled?: boolean;
  tierModels?: {
    SIMPLE?: string;
    MEDIUM?: string;
    COMPLEX?: string;
    REASONING?: string;
  };
};

// -- Scope --

export type MemoryScope = {
  tenantId?: string;
  userId: string;
  agentId: string;
  sessionKey: string;
};

export type FreeTextMemoryKind =
  | "preference"
  | "workflow"
  | "constraint"
  | "profile"
  | "relationship"
  | "tooling"
  | "technical"
  | "decision"
  | "architecture"
  | "work"
  | "lesson"
  | "benchmark"
  | "schedule"
  | "project"
  | "general";

export type FreeTextMemoryMetadata = {
  source: "memory-mem0";
  content_kind: "free-text";
  capture_kind?: "explicit" | "auto";
  memory_kind?: FreeTextMemoryKind;
  quality?: "durable" | "transient";
  workspace_agent?: string;
  scope_user_id?: string;
  scope_agent_id?: string;
  scope_session_key?: string;
  [key: string]: unknown;
};

// -- Records --

export type MemuMemoryRecord = {
  id?: string;
  text: string;
  category: string;
  score?: number;
  source: "memu_item" | "memu_category";
  scope: MemoryScope;
  metadata?: Record<string, unknown>;
  createdAt?: number;
};

export type CoreMemoryTier = "profile" | "technical" | "general";

export type CoreMemoryRecord = {
  id: string;
  category?: string;
  key: string;
  value: string;
  importance?: number;
  tier?: CoreMemoryTier;
  scope: MemoryScope;
  source?: string;
  score?: number;
  metadata?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  touchedAt?: number;
  expiresAt?: number;
};

export type CoreMemoryProposal = {
  id: string;
  category: string;
  text: string;
  key: string;
  value: string;
  reason: string;
  scope: MemoryScope;
  createdAt: number;
  status: "pending" | "approved" | "rejected";
  reviewedAt?: number;
  reviewer?: string;
};

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type OutboxItem = {
  id: string;
  createdAt: number;
  scope: MemoryScope;
  payload: {
    messages: ConversationMessage[];
    metadata?: Record<string, unknown>;
  };
  retryCount: number;
  nextRetryAt: number;
};

export type DeadLetterItem = OutboxItem & {
  failedAt: number;
  lastError: string;
};

export type CircuitState = "closed" | "open" | "half-open";

// -- memU-server response types --

export type MemuRetrieveResponse = {
  status: string;
  result: {
    categories?: unknown[];
    items?: unknown[];
    resources?: unknown[];
    next_step_query?: string;
  };
};

export type MemuMemorizeResponse = {
  status: string;
  result: unknown;
};

export type MemuClearResponse = {
  status: string;
  result: {
    purged_categories?: number;
    purged_items?: number;
    purged_resources?: number;
  };
};

export type MemuCategoriesResponse = {
  status: string;
  result: {
    categories: Array<{
      name: string;
      description?: string;
      user_id?: string;
      agent_id?: string;
      summary?: string;
    }>;
  };
};

// -- Plugin config --

export type ScopeConfig = {
  userId: string;
  userIdByAgent?: Record<string, string>;
  agentId: string;
  tenantId?: string;
};

export type LlmGateConfig = {
  enabled: boolean;
  apiBase: string;
  apiKey?: string;
  model: string;
  maxTokensPerBatch: number;
  timeoutMs: number;
};

export type DecayParams = {
  /** Ebbinghaus stability S (days): higher = slower decay */
  stabilityDays: number;
};

export type ConsolidationThresholds = {
  /** Score ≥ keep → always keep */
  keep: number;
  /** Score < delete → send to dead-letter and delete */
  delete: number;
  /** Score in [downgrade, keep) → downgrade tier or reduce weight */
  downgrade: number;
  /** Score < archive (and ≥ delete) → archive flag, skip injection */
  archive: number;
  /** Score in [llmLow, llmHigh] → ask LLM for verdict */
  llmLow: number;
  llmHigh: number;
};

export type CycleScheduleConfig = {
  enabled: boolean;
  /** Hour of day (0–23) to run this cycle */
  hourOfDay: number;
  /** Day of week (0=Sun, 1=Mon … 6=Sat) for weekly cycle. Omit = any day. */
  dayOfWeek?: number;
  /** Day of month (1–28) for monthly cycle. Omit = any day. */
  dayOfMonth?: number;
};

/**
 * LLM config for boundary-zone consolidation verdicts.
 * Supports any OpenAI-compatible endpoint:
 *   - Local Ollama:  apiBase="http://localhost:11434/v1"  model="qwen2.5:14b"
 *   - Kimi Coding:   apiBase="https://api.kimi.com/coding/v1"  model="k2p5"
 *   - OpenAI:        apiBase="https://api.openai.com/v1"  model="gpt-4o-mini"
 *   - Any LiteLLM/OpenRouter proxy
 */
export type ConsolidationLLMConfig = {
  enabled: boolean;
  apiBase: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  /** Max records to send to LLM in a single consolidation call */
  maxBatchSize: number;
};

/** @deprecated use ConsolidationLLMConfig */
export type QwenConsolidationConfig = ConsolidationLLMConfig;

export type ScoreWeights = {
  recency: number;
  accessFreq: number;
  novelty: number;
  typePrior: number;
  explicitImportance: number;
};

export type ConsolidationConfig = {
  enabled: boolean;
  /** Minimum interval between any consolidation run (guard against rapid re-runs) */
  intervalMs: number;
  /** Trigram similarity threshold for value dedup within a category */
  similarityThreshold: number;
  /** Score thresholds for keep/downgrade/archive/delete verdicts */
  thresholds: ConsolidationThresholds;
  /** Ebbinghaus decay parameters */
  decay: DecayParams;
  /** Five-factor score weights (should sum to 1.0) */
  weights: ScoreWeights;
  /** Per-cycle schedule overrides */
  schedule: {
    daily: CycleScheduleConfig;
    weekly: CycleScheduleConfig;
    monthly: CycleScheduleConfig;
  };
  /** LLM for boundary-zone verdicts (any OpenAI-compat endpoint: Ollama/Kimi/OpenAI/LiteLLM) */
  llm: ConsolidationLLMConfig;
  /** Path to write dead-letter log (deleted records) */
  deadLetterPath: string;
  /** Path to persist scheduler state (lastRun timestamps) */
  statePath: string;
};

export type MemuPluginConfig = {
  // -- Top-level simplified config (new format) --
  dataDir?: string;           // Base data directory, replaces multiple paths
  geminiApiKey?: string;      // Legacy alias for the shared LLM API key
  kimiApiKey?: string;        // Shared Kimi Coding API key for classifier, llmGate, mem0 LLM

  // -- Existing detailed config (backward compatible) --
  backend: {
    freeText: {
      provider: "mem0";
    };
  };
  mem0: {
    mode: "platform" | "open-source";
    apiKey?: string;
    orgId?: string;
    projectId?: string;
    enableGraph: boolean;
    searchThreshold: number;
    topK: number;
    customInstructions?: string;
    customPrompt?: string;
    /**
     * Default TTL for free-text memories in days.
     * 0 = never expire. Default: 90 days.
     */
    defaultTtlDays: number;
    oss?: {
      embedder?: { provider: string; config: Record<string, unknown> };
      vectorStore?: { provider: string; config: Record<string, unknown> };
      llm?: { provider: string; config: Record<string, unknown> };
      historyDbPath?: string;
      graph_store?: { provider: string; config: Record<string, unknown>; llm?: { provider: string; config: Record<string, unknown> } };
    };
  };
  scope: ScopeConfig;
  recall: {
    enabled: boolean;
    topK: number;
    threshold: number;            // Renamed from scoreThreshold
    maxChars: number;             // Renamed from maxContextChars/injectionBudgetChars
    cacheTtlMs: number;
    cacheMaxSize: number;
  };
  core: {
    enabled: boolean;
    topK: number;
    maxItemChars: number;
    persistPath: string;
    autoExtractProposals: boolean;
    humanReviewRequired: boolean;
    touchOnRecall: boolean;
    proposalQueueMax: number;
    alwaysInjectTiers: CoreMemoryTier[];
    alwaysInjectLimit: number;    // Renamed from maxAlwaysInjectChars
    consolidation: ConsolidationConfig;
    llmGate: LlmGateConfig;
  };
  capture: {
    enabled: boolean;
    minChars: number;
    maxChars: number;
    maxConversationTurns: number;
    dedupeThreshold: number;
    candidateQueue: {
      enabled: boolean;
      intervalMs: number;
      maxBatchSize: number;
    };
  };
  outbox: {
    enabled: boolean;
    concurrency: number;
    batchSize: number;
    maxRetries: number;
    drainTimeoutMs: number;
    persistPath: string;
    flushIntervalMs: number;
  };
  sync: {
    enabled: boolean;
    intervalMs: number;
    memoryFilePath: string;
  };
  classifier: ClassifierConfig;
  smartRouter: SmartRouterConfig;
};

// Backward compatibility aliases (for code that uses old field names)
export function getRecallThreshold(config: MemuPluginConfig): number {
  return config.recall.threshold;
}
export function getRecallMaxChars(config: MemuPluginConfig): number {
  return config.recall.maxChars;
}
export function getCoreAlwaysInjectLimit(config: MemuPluginConfig): number {
  return config.core.alwaysInjectLimit;
}
export function getSyncEnabled(config: MemuPluginConfig): boolean {
  return config.sync.enabled;
}
export function getSyncIntervalMs(config: MemuPluginConfig): number {
  return config.sync.intervalMs;
}

export const DEFAULT_CONFIG: MemuPluginConfig = {
  dataDir: "~/.openclaw/data/memory-mem0",
  geminiApiKey: undefined,
  kimiApiKey: undefined,
  backend: {
    freeText: {
      provider: "mem0",
    },
  },
  mem0: {
    mode: "open-source",
    apiKey: undefined,
    orgId: undefined,
    projectId: undefined,
    enableGraph: false,
    searchThreshold: 0.3,
    topK: 5,
    customInstructions: undefined,
    customPrompt: undefined,
    defaultTtlDays: 90,
    oss: undefined,
  },
  scope: {
    userId: "default_user",
    userIdByAgent: undefined,
    agentId: "main",
    tenantId: undefined,
  },
  recall: {
    enabled: true,
    topK: 5,
    threshold: 0.25,
    maxChars: 1500,
    cacheTtlMs: 60_000,
    cacheMaxSize: 100,
  },
  core: {
    enabled: true,
    topK: 10,
    maxItemChars: 300,
    persistPath: "~/.openclaw/data/memory-mem0",
    autoExtractProposals: true,
    humanReviewRequired: false,
    touchOnRecall: true,
    proposalQueueMax: 200,
    alwaysInjectTiers: ["profile", "general"] as CoreMemoryTier[],
    alwaysInjectLimit: 800,
    consolidation: {
      enabled: true,
      intervalMs: 3_600_000,
      similarityThreshold: 0.85,
      thresholds: {
        keep: 0.65,
        downgrade: 0.45,
        archive: 0.25,
        delete: 0.10,
        llmLow: 0.35,
        llmHigh: 0.55,
      },
      decay: {
        stabilityDays: 14,
      },
      weights: {
        recency: 0.30,
        accessFreq: 0.20,
        novelty: 0.20,
        typePrior: 0.15,
        explicitImportance: 0.15,
      },
      schedule: {
        daily:   { enabled: true,  hourOfDay: 3 },
        weekly:  { enabled: true,  hourOfDay: 4, dayOfWeek: 1 },   // Monday 04:00
        monthly: { enabled: true,  hourOfDay: 5, dayOfMonth: 1 },  // 1st of month 05:00
      },
      llm: {
        enabled: false,
        apiBase: "http://localhost:11434/v1",
        apiKey: undefined,
        model: "qwen2.5:14b",
        timeoutMs: 30_000,
        maxBatchSize: 20,
      },
      deadLetterPath: "~/.openclaw/data/memory-mem0/consolidation-dead-letter.jsonl",
      statePath: "~/.openclaw/data/memory-mem0/consolidation-state.json",
    },
    llmGate: {
      enabled: false,
      apiBase: getKimiCodingBaseUrl(),
      apiKey: undefined,
      model: getKimiCodingDefaultModel(),
      maxTokensPerBatch: 4000,
      timeoutMs: 60_000,
    },
  },
  capture: {
    enabled: true,
    minChars: 20,
    maxChars: 600,
    maxConversationTurns: 6,
    dedupeThreshold: 0.8,
    candidateQueue: {
      enabled: true,
      intervalMs: 10_000,
      maxBatchSize: 50,
    },
  },
  outbox: {
    enabled: true,
    concurrency: 2,
    batchSize: 10,
    maxRetries: 5,
    drainTimeoutMs: 5_000,
    persistPath: "~/.openclaw/data/memory-mem0",
    flushIntervalMs: 10_000,
  },
  sync: {
    enabled: true,
    intervalMs: 300_000,
    memoryFilePath: "~/.openclaw/workspace/MEMORY.md",
  },
  classifier: {
    enabled: true,
    model: getKimiCodingDefaultModel(),
    apiBase: getKimiCodingBaseUrl(),
    apiKey: undefined,
    cacheTtlMs: 300_000,
    cacheMaxSize: 200,
  },
  smartRouter: {
    enabled: false,
    tierModels: undefined,
  },
};

export function buildSessionKey(scope: ScopeConfig): string {
  return `agent:${scope.agentId}:main`;
}

export function buildScope(cfg: ScopeConfig): MemoryScope {
  return {
    tenantId: cfg.tenantId,
    userId: cfg.userId,
    agentId: cfg.agentId,
    sessionKey: buildSessionKey(cfg),
  };
}

// -- Dynamic scope from runtime context --

export type PluginHookContext = {
  agentId?: string;
  channelId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
};

function inferAgentIdFromSession(ctx?: PluginHookContext): string | undefined {
  const raw = ctx?.sessionKey ?? ctx?.sessionId;
  if (!raw || typeof raw !== "string") return undefined;
  // OpenClaw common form: "agent:<agentId>:<lane...>"
  if (raw.startsWith("agent:")) {
    const parts = raw.split(":");
    if (parts.length >= 2 && parts[1]) return parts[1];
  }
  return undefined;
}

/**
 * Build a MemoryScope that merges static config with runtime context.
 * Runtime ctx.agentId / ctx.sessionKey take precedence over config values,
 * enabling multi-agent isolation without per-agent config.
 */
export function buildDynamicScope(cfg: ScopeConfig, ctx?: PluginHookContext): MemoryScope {
  const inferredAgentId = inferAgentIdFromSession(ctx);
  const resolvedAgentId = ctx?.agentId ?? inferredAgentId ?? cfg.agentId;
  const mappedUserId = cfg.userIdByAgent?.[resolvedAgentId];
  const merged: ScopeConfig = {
    ...cfg,
    userId: mappedUserId ?? cfg.userId,
    agentId: resolvedAgentId,
  };

  const scope = buildScope(merged);
  if (!scope.userId || !scope.agentId) {
    throw new Error(`Invalid memory scope: userId="${scope.userId}" agentId="${scope.agentId}" must be non-empty`);
  }

  // Prefer the real OpenClaw sessionKey when available.
  // This improves isolation/dedupe across conversations and aligns metadata/resource URLs.
  if (ctx?.sessionKey && typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()) {
    scope.sessionKey = ctx.sessionKey.trim();
  }

  return scope;
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === "boolean" ? v : def;
}

function num(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : def;
}

/** Like num() but allows zero — use for configs where 0 is a valid explicit value */
function numAllowZero(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : def;
}

function numInRange(v: unknown, def: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return def;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function str(v: unknown, def: string): string {
  return typeof v === "string" && v.length > 0 ? v : def;
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function strMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw === "string" && raw.trim()) out[k] = raw.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const VALID_TIERS: CoreMemoryTier[] = ["profile", "technical", "general"];

function parseTierArray(v: unknown, def: CoreMemoryTier[]): CoreMemoryTier[] {
  if (!Array.isArray(v)) return def;
  const filtered = v.filter((t): t is CoreMemoryTier => typeof t === "string" && VALID_TIERS.includes(t as CoreMemoryTier));
  return filtered.length > 0 ? filtered : def;
}

function parseMem0Llm(raw: unknown, fallbackApiKey?: string): { provider: string; config: Record<string, unknown> } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const llmRaw = raw as { provider?: unknown; config?: unknown };
  if (typeof llmRaw.provider !== "string") return undefined;
  return normalizeMem0LlmConfig({
    provider: llmRaw.provider,
    config: llmRaw.config && typeof llmRaw.config === "object"
      ? llmRaw.config as Record<string, unknown>
      : {},
  }, fallbackApiKey);
}

export function loadConfig(raw?: Record<string, unknown>): MemuPluginConfig {
  if (!raw) return { ...DEFAULT_CONFIG };

  // Top-level simplified config
  const dataDir = optStr(raw.dataDir) ?? DEFAULT_CONFIG.dataDir;
  const kimiApiKey = optStr(raw.kimiApiKey) ?? optStr(raw.geminiApiKey);
  const geminiApiKey = optStr(raw.geminiApiKey);

  const b = (raw.backend ?? {}) as Record<string, unknown>;
  const ft = (b.freeText ?? {}) as Record<string, unknown>;
  const mem0 = (raw.mem0 ?? {}) as Record<string, unknown>;
  const sc = (raw.scope ?? {}) as Record<string, unknown>;
  const r = (raw.recall ?? {}) as Record<string, unknown>;
  const co = (raw.core ?? {}) as Record<string, unknown>;
  const c = (raw.capture ?? {}) as Record<string, unknown>;
  const o = (raw.outbox ?? {}) as Record<string, unknown>;
  const s = (raw.sync ?? {}) as Record<string, unknown>;

  // Parse oss config with graph_store support and shared API key inheritance
  const ossRaw = mem0.oss as Record<string, unknown> | undefined;
  const oss = ossRaw && typeof ossRaw === "object"
    ? {
        embedder: ossRaw.embedder && typeof ossRaw.embedder === "object"
          ? (ossRaw.embedder as { provider: string; config: Record<string, unknown> })
          : undefined,
        vectorStore: ossRaw.vectorStore && typeof ossRaw.vectorStore === "object"
          ? (ossRaw.vectorStore as { provider: string; config: Record<string, unknown> })
          : undefined,
        llm: parseMem0Llm(ossRaw.llm, kimiApiKey),
        historyDbPath: typeof ossRaw.historyDbPath === "string" ? ossRaw.historyDbPath : undefined,
        graph_store: ossRaw.graph_store && typeof ossRaw.graph_store === "object"
          ? {
              ...(ossRaw.graph_store as { provider: string; config: Record<string, unknown> }),
              llm: parseMem0Llm((ossRaw.graph_store as Record<string, unknown>).llm, kimiApiKey),
            }
          : undefined,
      }
    : undefined;

  // Backward compatibility: support old config field names
  const recallThreshold = typeof r.threshold === "number" ? r.threshold
    : typeof r.scoreThreshold === "number" ? r.scoreThreshold
    : DEFAULT_CONFIG.recall.threshold;
  // Use numAllowZero so explicit 0 disables injection instead of falling through to default
  const recallMaxChars = typeof r.maxChars === "number" ? numAllowZero(r.maxChars, DEFAULT_CONFIG.recall.maxChars)
    : typeof r.maxContextChars === "number" ? numAllowZero(r.maxContextChars, DEFAULT_CONFIG.recall.maxChars)
    : num(r.injectionBudgetChars, DEFAULT_CONFIG.recall.maxChars);
  const coreAlwaysInjectLimit = typeof co.alwaysInjectLimit === "number" ? numAllowZero(co.alwaysInjectLimit, DEFAULT_CONFIG.core.alwaysInjectLimit)
    : num(co.maxAlwaysInjectChars, DEFAULT_CONFIG.core.alwaysInjectLimit);
  const syncEnabled = bool(s.enabled, bool(s.flushToMarkdown, DEFAULT_CONFIG.sync.enabled));
  const syncIntervalMs = num(s.intervalMs, 0) || num(s.flushIntervalSec, 0) * 1000 || DEFAULT_CONFIG.sync.intervalMs;

  return {
    dataDir,
    geminiApiKey,
    kimiApiKey,
    backend: {
      freeText: {
        provider: ft.provider === "mem0" ? "mem0" : DEFAULT_CONFIG.backend.freeText.provider,
      },
    },
    mem0: {
      mode: mem0.mode === "platform" ? "platform" : DEFAULT_CONFIG.mem0.mode,
      apiKey: optStr(mem0.apiKey),
      orgId: optStr(mem0.orgId),
      projectId: optStr(mem0.projectId),
      enableGraph: bool(mem0.enableGraph, DEFAULT_CONFIG.mem0.enableGraph),
      searchThreshold: typeof mem0.searchThreshold === "number" ? mem0.searchThreshold
        : typeof mem0.threshold === "number" ? mem0.threshold
        : DEFAULT_CONFIG.mem0.searchThreshold,
      topK: numInRange(mem0.topK, DEFAULT_CONFIG.mem0.topK, 1, 50),
      customInstructions: optStr(mem0.customInstructions),
      customPrompt: optStr(mem0.customPrompt),
      defaultTtlDays: numInRange(mem0.defaultTtlDays, DEFAULT_CONFIG.mem0.defaultTtlDays, 0, 3650),
      oss,
    },
    scope: {
      userId: str(sc.userId, DEFAULT_CONFIG.scope.userId),
      userIdByAgent: strMap(sc.userIdByAgent),
      agentId: str(sc.agentId, DEFAULT_CONFIG.scope.agentId),
      tenantId: optStr(sc.tenantId),
    },
    recall: {
      enabled: bool(r.enabled, DEFAULT_CONFIG.recall.enabled),
      topK: num(r.topK, DEFAULT_CONFIG.recall.topK),
      threshold: recallThreshold,
      maxChars: recallMaxChars,
      cacheTtlMs: num(r.cacheTtlMs, DEFAULT_CONFIG.recall.cacheTtlMs),
      cacheMaxSize: num(r.cacheMaxSize, DEFAULT_CONFIG.recall.cacheMaxSize),
    },
    core: {
      enabled: bool(co.enabled, DEFAULT_CONFIG.core.enabled),
      topK: numInRange(co.topK, DEFAULT_CONFIG.core.topK, 1, 50),
      maxItemChars: numInRange(co.maxItemChars, DEFAULT_CONFIG.core.maxItemChars, 30, 2_000),
      persistPath: typeof co.persistPath === "string" ? co.persistPath : dataDir ?? DEFAULT_CONFIG.core.persistPath,
      autoExtractProposals: bool(co.autoExtractProposals, DEFAULT_CONFIG.core.autoExtractProposals),
      humanReviewRequired: bool(co.humanReviewRequired, DEFAULT_CONFIG.core.humanReviewRequired),
      touchOnRecall: bool(co.touchOnRecall, DEFAULT_CONFIG.core.touchOnRecall),
      proposalQueueMax: numInRange(co.proposalQueueMax, DEFAULT_CONFIG.core.proposalQueueMax, 10, 5_000),
      alwaysInjectTiers: parseTierArray(co.alwaysInjectTiers, DEFAULT_CONFIG.core.alwaysInjectTiers),
      alwaysInjectLimit: coreAlwaysInjectLimit,
      consolidation: (() => {
        const cn = (co.consolidation ?? {}) as Record<string, unknown>;
        const def = DEFAULT_CONFIG.core.consolidation;
        const cnTh = ((cn.thresholds ?? {}) as Record<string, unknown>);
        const cnDe = ((cn.decay ?? {}) as Record<string, unknown>);
        const cnWe = ((cn.weights ?? {}) as Record<string, unknown>);
        const cnSc = ((cn.schedule ?? {}) as Record<string, Record<string, unknown>>);
        const cnQw = ((cn.llm ?? cn.qwen ?? {}) as Record<string, unknown>); // accept both "llm" and legacy "qwen" key
        return {
          enabled: bool(cn.enabled, def.enabled),
          intervalMs: num(cn.intervalMs, def.intervalMs),
          similarityThreshold: numInRange(cn.similarityThreshold, def.similarityThreshold, 0.5, 1),
          thresholds: {
            keep:     num(cnTh.keep,      def.thresholds.keep),
            downgrade:num(cnTh.downgrade, def.thresholds.downgrade),
            archive:  num(cnTh.archive,   def.thresholds.archive),
            delete:   num(cnTh.delete,    def.thresholds.delete),
            llmLow:   num(cnTh.llmLow,    def.thresholds.llmLow),
            llmHigh:  num(cnTh.llmHigh,   def.thresholds.llmHigh),
          },
          decay: {
            stabilityDays: num(cnDe.stabilityDays, def.decay.stabilityDays),
          },
          weights: {
            recency:            num(cnWe.recency,            def.weights.recency),
            accessFreq:         num(cnWe.accessFreq,         def.weights.accessFreq),
            novelty:            num(cnWe.novelty,            def.weights.novelty),
            typePrior:          num(cnWe.typePrior,          def.weights.typePrior),
            explicitImportance: num(cnWe.explicitImportance, def.weights.explicitImportance),
          },
          schedule: {
            daily:   { enabled: bool((cnSc.daily   ?? {}).enabled, def.schedule.daily.enabled),   hourOfDay: num((cnSc.daily   ?? {}).hourOfDay, def.schedule.daily.hourOfDay) },
            weekly:  { enabled: bool((cnSc.weekly  ?? {}).enabled, def.schedule.weekly.enabled),  hourOfDay: num((cnSc.weekly  ?? {}).hourOfDay, def.schedule.weekly.hourOfDay),  ...(((cnSc.weekly  ?? {}).dayOfWeek  != null) ? { dayOfWeek:  num((cnSc.weekly  ?? {}).dayOfWeek,  def.schedule.weekly.dayOfWeek  ?? 1) } : (def.schedule.weekly.dayOfWeek  != null ? { dayOfWeek:  def.schedule.weekly.dayOfWeek  } : {})) },
            monthly: { enabled: bool((cnSc.monthly ?? {}).enabled, def.schedule.monthly.enabled), hourOfDay: num((cnSc.monthly ?? {}).hourOfDay, def.schedule.monthly.hourOfDay), ...(((cnSc.monthly ?? {}).dayOfMonth != null) ? { dayOfMonth: num((cnSc.monthly ?? {}).dayOfMonth, def.schedule.monthly.dayOfMonth ?? 1) } : (def.schedule.monthly.dayOfMonth != null ? { dayOfMonth: def.schedule.monthly.dayOfMonth } : {})) },
          },
          llm: {
            enabled:      bool(cnQw.enabled,      def.llm.enabled),
            apiBase:      optStr(cnQw.apiBase) ?? def.llm.apiBase,
            apiKey:       optStr(cnQw.apiKey),
            model:        optStr(cnQw.model) ?? def.llm.model,
            timeoutMs:    num(cnQw.timeoutMs,    def.llm.timeoutMs),
            maxBatchSize: num(cnQw.maxBatchSize, def.llm.maxBatchSize),
          },
          deadLetterPath: optStr(cn.deadLetterPath) ?? def.deadLetterPath,
          statePath:      optStr(cn.statePath) ?? def.statePath,
        };
      })(),
      llmGate: (() => {
        const lg = (co.llmGate ?? {}) as Record<string, unknown>;
        return {
          enabled: bool(lg.enabled, DEFAULT_CONFIG.core.llmGate.enabled),
          ...normalizeChatApiConfig({
            apiBase: optStr(lg.apiBase) ?? DEFAULT_CONFIG.core.llmGate.apiBase,
            model: optStr(lg.model) ?? DEFAULT_CONFIG.core.llmGate.model,
          }),
          apiKey: optStr(lg.apiKey) ?? kimiApiKey ?? (typeof process !== "undefined" ? process.env.MEM0_LLM_GATE_API_KEY : undefined),
          maxTokensPerBatch: numInRange(lg.maxTokensPerBatch, DEFAULT_CONFIG.core.llmGate.maxTokensPerBatch, 500, 10_000),
          timeoutMs: numInRange(lg.timeoutMs, DEFAULT_CONFIG.core.llmGate.timeoutMs, 5_000, 120_000),
        };
      })(),
    },
    capture: {
      enabled: bool(c.enabled, DEFAULT_CONFIG.capture.enabled),
      minChars: num(c.minChars, DEFAULT_CONFIG.capture.minChars),
      maxChars: num(c.maxChars, DEFAULT_CONFIG.capture.maxChars),
      maxConversationTurns: numInRange(c.maxConversationTurns, DEFAULT_CONFIG.capture.maxConversationTurns, 1, 20),
      dedupeThreshold: typeof c.dedupeThreshold === "number" ? c.dedupeThreshold : DEFAULT_CONFIG.capture.dedupeThreshold,
      candidateQueue: (() => {
        const cq = (c.candidateQueue ?? {}) as Record<string, unknown>;
        // Support simplified batchIntervalMs
        const intervalMs = num(cq.intervalMs, 0) || num(c.batchIntervalMs, DEFAULT_CONFIG.capture.candidateQueue.intervalMs);
        return {
          enabled: bool(cq.enabled, DEFAULT_CONFIG.capture.candidateQueue.enabled),
          intervalMs,
          maxBatchSize: numInRange(cq.maxBatchSize, DEFAULT_CONFIG.capture.candidateQueue.maxBatchSize, 1, 200),
        };
      })(),
    },
    outbox: {
      enabled: bool(o.enabled, DEFAULT_CONFIG.outbox.enabled),
      concurrency: num(o.concurrency, DEFAULT_CONFIG.outbox.concurrency),
      batchSize: num(o.batchSize, DEFAULT_CONFIG.outbox.batchSize),
      maxRetries: num(o.maxRetries, DEFAULT_CONFIG.outbox.maxRetries),
      drainTimeoutMs: num(o.drainTimeoutMs, DEFAULT_CONFIG.outbox.drainTimeoutMs),
      persistPath: typeof o.persistPath === "string" ? o.persistPath : dataDir ?? DEFAULT_CONFIG.outbox.persistPath,
      flushIntervalMs: num(o.flushIntervalMs, DEFAULT_CONFIG.outbox.flushIntervalMs),
    },
    sync: {
      enabled: syncEnabled,
      intervalMs: syncIntervalMs,
      memoryFilePath: optStr(s.memoryFilePath) ?? optStr(s.filePath) ?? DEFAULT_CONFIG.sync.memoryFilePath,
    },
    classifier: (() => {
      const cl = (raw.classifier ?? {}) as Record<string, unknown>;
      return {
        enabled: bool(cl.enabled, DEFAULT_CONFIG.classifier.enabled ?? true),
        ...normalizeChatApiConfig({
          apiBase: optStr(cl.apiBase) ?? DEFAULT_CONFIG.classifier.apiBase,
          model: optStr(cl.model) ?? DEFAULT_CONFIG.classifier.model,
        }),
        apiKey: optStr(cl.apiKey) ?? kimiApiKey ?? (typeof process !== "undefined" ? process.env.MEM0_CLASSIFIER_API_KEY : undefined),
        cacheTtlMs: num(cl.cacheTtlMs, DEFAULT_CONFIG.classifier.cacheTtlMs ?? 300_000),
        cacheMaxSize: num(cl.cacheMaxSize, DEFAULT_CONFIG.classifier.cacheMaxSize ?? 200),
      };
    })(),
    smartRouter: (() => {
      const sr = (raw.smartRouter ?? {}) as Record<string, unknown>;
      const tierModels = (sr.tierModels ?? {}) as Record<string, unknown>;
      return {
        enabled: bool(sr.enabled, DEFAULT_CONFIG.smartRouter.enabled ?? false),
        tierModels: {
          SIMPLE: optStr(tierModels.SIMPLE),
          MEDIUM: optStr(tierModels.MEDIUM),
          COMPLEX: optStr(tierModels.COMPLEX),
          REASONING: optStr(tierModels.REASONING),
        },
      };
    })(),
  };
}
