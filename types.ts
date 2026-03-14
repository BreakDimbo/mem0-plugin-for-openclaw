// ============================================================================
// Types & Default Configuration for memory-memu plugin
// Aligned with 设计文档 v3.0 — full MemoryScope + Phase 2/3 config
// ============================================================================

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
  | "schedule"
  | "project"
  | "general";

export type FreeTextMemoryMetadata = {
  source: "memory-memu";
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

export type CoreMemoryRecord = {
  id: string;
  category?: string;
  key: string;
  value: string;
  importance?: number;
  scope: MemoryScope;
  source?: string;
  score?: number;
  metadata?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  touchedAt?: number;
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

export type OutboxItem = {
  id: string;
  createdAt: number;
  scope: MemoryScope;
  payload: {
    text: string;
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
  requireUserId: boolean;
  requireAgentId: boolean;
};

export type MemuPluginConfig = {
  backend: {
    freeText: {
      provider: "memu" | "mem0";
      dualWrite: boolean;
      readFallback: "none" | "memu";
      compareRecall: boolean;
    };
  };
  memu: {
    baseUrl: string;
    timeoutMs: number;
    cbResetMs: number;
    healthCheckPath: string;
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
    oss?: {
      embedder?: { provider: string; config: Record<string, unknown> };
      vectorStore?: { provider: string; config: Record<string, unknown> };
      llm?: { provider: string; config: Record<string, unknown> };
      historyDbPath?: string;
    };
  };
  scope: ScopeConfig;
  recall: {
    enabled: boolean;
    method: "rag" | "llm";
    hybrid: {
      enabled: boolean;
      alpha: number;
      fallbackToRag: boolean;
    };
    topK: number;
    scoreThreshold: number;
    maxContextChars: number;
    injectionBudgetChars: number;
    cacheTtlMs: number;
    cacheMaxSize: number;
  };
  core: {
    enabled: boolean;
    topK: number;
    maxItemChars: number;
    autoExtractProposals: boolean;
    humanReviewRequired: boolean;
    touchOnRecall: boolean;
    proposalQueueMax: number;
  };
  capture: {
    enabled: boolean;
    maxItemsPerRun: number;
    minChars: number;
    maxChars: number;
    dedupeThreshold: number;
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
    flushToMarkdown: boolean;
    flushIntervalSec: number;
    memoryFilePath: string;
  };
};

export const DEFAULT_CONFIG: MemuPluginConfig = {
  backend: {
    freeText: {
      provider: "memu",
      dualWrite: false,
      readFallback: "memu",
      compareRecall: false,
    },
  },
  memu: {
    baseUrl: "http://127.0.0.1:8000",
    timeoutMs: 12000,
    cbResetMs: 10_000,
    healthCheckPath: "/debug",
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
    oss: undefined,
  },
  scope: {
    userId: "default_user",
    userIdByAgent: undefined,
    agentId: "main",
    tenantId: undefined,
    requireUserId: true,
    requireAgentId: true,
  },
  recall: {
    enabled: true,
    method: "rag",
    hybrid: {
      enabled: false,
      alpha: 0.7,
      fallbackToRag: true,
    },
    topK: 3,
    scoreThreshold: 0.30,
    maxContextChars: 1200,
    injectionBudgetChars: 1600,
    cacheTtlMs: 60_000,
    cacheMaxSize: 100,
  },
  core: {
    enabled: true,
    topK: 8,
    maxItemChars: 240,
    autoExtractProposals: true,
    humanReviewRequired: true,
    touchOnRecall: true,
    proposalQueueMax: 200,
  },
  capture: {
    enabled: true,
    maxItemsPerRun: 2,
    minChars: 24,
    maxChars: 400,
    dedupeThreshold: 0.8,
  },
  outbox: {
    enabled: true,
    concurrency: 2,
    batchSize: 10,
    maxRetries: 5,
    drainTimeoutMs: 5_000,
    persistPath: "~/.openclaw/data/memory-memu",
    flushIntervalMs: 10_000,
  },
  sync: {
    flushToMarkdown: true,
    flushIntervalSec: 300,
    memoryFilePath: "",
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
  return typeof v === "number" && v > 0 ? v : def;
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

export function loadConfig(raw?: Record<string, unknown>): MemuPluginConfig {
  if (!raw) return { ...DEFAULT_CONFIG };

  const m = (raw.memu ?? {}) as Record<string, unknown>;
  const b = (raw.backend ?? {}) as Record<string, unknown>;
  const ft = (b.freeText ?? {}) as Record<string, unknown>;
  const mem0 = (raw.mem0 ?? {}) as Record<string, unknown>;
  const sc = (raw.scope ?? {}) as Record<string, unknown>;
  const r = (raw.recall ?? {}) as Record<string, unknown>;
  const co = (raw.core ?? {}) as Record<string, unknown>;
  const c = (raw.capture ?? {}) as Record<string, unknown>;
  const o = (raw.outbox ?? {}) as Record<string, unknown>;
  const s = (raw.sync ?? {}) as Record<string, unknown>;

  return {
    memu: {
      baseUrl: str(m.baseUrl, DEFAULT_CONFIG.memu.baseUrl),
      timeoutMs: numInRange(m.timeoutMs, DEFAULT_CONFIG.memu.timeoutMs, 500, 30_000),
      cbResetMs: numInRange(m.cbResetMs, DEFAULT_CONFIG.memu.cbResetMs, 1_000, 120_000),
      healthCheckPath: str(m.healthCheckPath, DEFAULT_CONFIG.memu.healthCheckPath),
    },
    backend: {
      freeText: {
        provider: ft.provider === "mem0" ? "mem0" : DEFAULT_CONFIG.backend.freeText.provider,
        dualWrite: bool(ft.dualWrite, DEFAULT_CONFIG.backend.freeText.dualWrite),
        readFallback: ft.readFallback === "none" ? "none" : DEFAULT_CONFIG.backend.freeText.readFallback,
        compareRecall: bool(ft.compareRecall, DEFAULT_CONFIG.backend.freeText.compareRecall),
      },
    },
    mem0: {
      mode: mem0.mode === "platform" ? "platform" : DEFAULT_CONFIG.mem0.mode,
      apiKey: optStr(mem0.apiKey),
      orgId: optStr(mem0.orgId),
      projectId: optStr(mem0.projectId),
      enableGraph: bool(mem0.enableGraph, DEFAULT_CONFIG.mem0.enableGraph),
      searchThreshold:
        typeof mem0.searchThreshold === "number" ? mem0.searchThreshold : DEFAULT_CONFIG.mem0.searchThreshold,
      topK: numInRange(mem0.topK, DEFAULT_CONFIG.mem0.topK, 1, 50),
      customInstructions: optStr(mem0.customInstructions),
      customPrompt: optStr(mem0.customPrompt),
      oss: mem0.oss && typeof mem0.oss === "object"
        ? {
            embedder:
              (mem0.oss as Record<string, unknown>).embedder &&
              typeof (mem0.oss as Record<string, unknown>).embedder === "object"
                ? ((mem0.oss as Record<string, unknown>).embedder as { provider: string; config: Record<string, unknown> })
                : undefined,
            vectorStore:
              (mem0.oss as Record<string, unknown>).vectorStore &&
              typeof (mem0.oss as Record<string, unknown>).vectorStore === "object"
                ? ((mem0.oss as Record<string, unknown>).vectorStore as { provider: string; config: Record<string, unknown> })
                : undefined,
            llm:
              (mem0.oss as Record<string, unknown>).llm &&
              typeof (mem0.oss as Record<string, unknown>).llm === "object"
                ? ((mem0.oss as Record<string, unknown>).llm as { provider: string; config: Record<string, unknown> })
                : undefined,
            historyDbPath:
              typeof (mem0.oss as Record<string, unknown>).historyDbPath === "string"
                ? ((mem0.oss as Record<string, unknown>).historyDbPath as string)
                : undefined,
          }
        : undefined,
    },
    scope: {
      userId: str(sc.userId, DEFAULT_CONFIG.scope.userId),
      userIdByAgent: strMap(sc.userIdByAgent),
      agentId: str(sc.agentId, DEFAULT_CONFIG.scope.agentId),
      tenantId: optStr(sc.tenantId),
      requireUserId: bool(sc.requireUserId, DEFAULT_CONFIG.scope.requireUserId),
      requireAgentId: bool(sc.requireAgentId, DEFAULT_CONFIG.scope.requireAgentId),
    },
    recall: {
      enabled: bool(r.enabled, DEFAULT_CONFIG.recall.enabled),
      method: r.method === "llm" ? "llm" : DEFAULT_CONFIG.recall.method,
      hybrid: {
        enabled: bool((r.hybrid as Record<string, unknown> | undefined)?.enabled, DEFAULT_CONFIG.recall.hybrid.enabled),
        alpha: numInRange((r.hybrid as Record<string, unknown> | undefined)?.alpha, DEFAULT_CONFIG.recall.hybrid.alpha, 0, 1),
        fallbackToRag: bool(
          (r.hybrid as Record<string, unknown> | undefined)?.fallbackToRag,
          DEFAULT_CONFIG.recall.hybrid.fallbackToRag,
        ),
      },
      topK: num(r.topK, DEFAULT_CONFIG.recall.topK),
      scoreThreshold: typeof r.scoreThreshold === "number" ? r.scoreThreshold : DEFAULT_CONFIG.recall.scoreThreshold,
      maxContextChars: num(r.maxContextChars, DEFAULT_CONFIG.recall.maxContextChars),
      injectionBudgetChars: numInRange(r.injectionBudgetChars, DEFAULT_CONFIG.recall.injectionBudgetChars, 300, 20_000),
      cacheTtlMs: num(r.cacheTtlMs, DEFAULT_CONFIG.recall.cacheTtlMs),
      cacheMaxSize: num(r.cacheMaxSize, DEFAULT_CONFIG.recall.cacheMaxSize),
    },
    core: {
      enabled: bool(co.enabled, DEFAULT_CONFIG.core.enabled),
      topK: numInRange(co.topK, DEFAULT_CONFIG.core.topK, 1, 50),
      maxItemChars: numInRange(co.maxItemChars, DEFAULT_CONFIG.core.maxItemChars, 30, 2_000),
      autoExtractProposals: bool(co.autoExtractProposals, DEFAULT_CONFIG.core.autoExtractProposals),
      humanReviewRequired: bool(co.humanReviewRequired, DEFAULT_CONFIG.core.humanReviewRequired),
      touchOnRecall: bool(co.touchOnRecall, DEFAULT_CONFIG.core.touchOnRecall),
      proposalQueueMax: numInRange(co.proposalQueueMax, DEFAULT_CONFIG.core.proposalQueueMax, 10, 5_000),
    },
    capture: {
      enabled: bool(c.enabled, DEFAULT_CONFIG.capture.enabled),
      maxItemsPerRun: num(c.maxItemsPerRun, DEFAULT_CONFIG.capture.maxItemsPerRun),
      minChars: num(c.minChars, DEFAULT_CONFIG.capture.minChars),
      maxChars: num(c.maxChars, DEFAULT_CONFIG.capture.maxChars),
      dedupeThreshold: typeof c.dedupeThreshold === "number" ? c.dedupeThreshold : DEFAULT_CONFIG.capture.dedupeThreshold,
    },
    outbox: {
      enabled: bool(o.enabled, DEFAULT_CONFIG.outbox.enabled),
      concurrency: num(o.concurrency, DEFAULT_CONFIG.outbox.concurrency),
      batchSize: num(o.batchSize, DEFAULT_CONFIG.outbox.batchSize),
      maxRetries: num(o.maxRetries, DEFAULT_CONFIG.outbox.maxRetries),
      drainTimeoutMs: num(o.drainTimeoutMs, DEFAULT_CONFIG.outbox.drainTimeoutMs),
      persistPath: typeof o.persistPath === "string" ? o.persistPath : DEFAULT_CONFIG.outbox.persistPath,
      flushIntervalMs: num(o.flushIntervalMs, DEFAULT_CONFIG.outbox.flushIntervalMs),
    },
    sync: {
      flushToMarkdown: bool(s.flushToMarkdown, DEFAULT_CONFIG.sync.flushToMarkdown),
      flushIntervalSec: num(s.flushIntervalSec, DEFAULT_CONFIG.sync.flushIntervalSec),
      memoryFilePath: (s.memoryFilePath as string) ?? DEFAULT_CONFIG.sync.memoryFilePath,
    },
  };
}
