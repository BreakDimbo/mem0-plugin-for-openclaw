// ============================================================================
// Types & Default Configuration for memory-memu plugin
// Aligned with 设计文档 v3.0 — full MemoryScope + Phase 2/3 config
// ============================================================================

// -- Scope --

export type MemoryScope = {
  tenantId?: string;
  userId: string;
  agentId: string;
  channelId?: string;
  threadId?: string;
  sessionKey: string;
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
  channelId?: string;
  threadId?: string;
  tenantId?: string;
  requireUserId: boolean;
  requireAgentId: boolean;
  isolateByChannel: boolean;
  isolateByThread: boolean;
};

export type MemuPluginConfig = {
  memu: {
    baseUrl: string;
    timeoutMs: number;
    cbResetMs: number;
    healthCheckPath: string;
  };
  scope: ScopeConfig;
  recall: {
    enabled: boolean;
    method: "rag" | "llm";
    topK: number;
    scoreThreshold: number;
    maxContextChars: number;
    cacheTtlMs: number;
    cacheMaxSize: number;
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
  memu: {
    baseUrl: "http://127.0.0.1:8000",
    timeoutMs: 12000,
    cbResetMs: 10_000,
    healthCheckPath: "/debug",
  },
  scope: {
    userId: "default_user",
    userIdByAgent: undefined,
    agentId: "main",
    channelId: undefined,
    threadId: undefined,
    tenantId: undefined,
    requireUserId: true,
    requireAgentId: true,
    isolateByChannel: true,
    isolateByThread: true,
  },
  recall: {
    enabled: true,
    method: "rag",
    topK: 3,
    scoreThreshold: 0.30,
    maxContextChars: 1200,
    cacheTtlMs: 60_000,
    cacheMaxSize: 100,
  },
  capture: {
    enabled: true,
    maxItemsPerRun: 3,
    minChars: 10,
    maxChars: 500,
    dedupeThreshold: 0.95,
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
  const parts = [`agent:${scope.agentId}`];
  if (scope.channelId) parts.push(scope.channelId);
  if (scope.threadId) parts.push(scope.threadId);
  return parts.join(":");
}

export function buildScope(cfg: ScopeConfig): MemoryScope {
  return {
    tenantId: cfg.tenantId,
    userId: cfg.userId,
    agentId: cfg.agentId,
    channelId: cfg.channelId,
    threadId: cfg.threadId,
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
 * Runtime ctx.agentId / ctx.channelId take precedence over config values,
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
    channelId: ctx?.channelId ?? cfg.channelId,
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
  const sc = (raw.scope ?? {}) as Record<string, unknown>;
  const r = (raw.recall ?? {}) as Record<string, unknown>;
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
    scope: {
      userId: str(sc.userId, DEFAULT_CONFIG.scope.userId),
      userIdByAgent: strMap(sc.userIdByAgent),
      agentId: str(sc.agentId, DEFAULT_CONFIG.scope.agentId),
      channelId: optStr(sc.channelId),
      threadId: optStr(sc.threadId),
      tenantId: optStr(sc.tenantId),
      requireUserId: bool(sc.requireUserId, DEFAULT_CONFIG.scope.requireUserId),
      requireAgentId: bool(sc.requireAgentId, DEFAULT_CONFIG.scope.requireAgentId),
      isolateByChannel: bool(sc.isolateByChannel, DEFAULT_CONFIG.scope.isolateByChannel),
      isolateByThread: bool(sc.isolateByThread, DEFAULT_CONFIG.scope.isolateByThread),
    },
    recall: {
      enabled: bool(r.enabled, DEFAULT_CONFIG.recall.enabled),
      method: r.method === "llm" ? "llm" : DEFAULT_CONFIG.recall.method,
      topK: num(r.topK, DEFAULT_CONFIG.recall.topK),
      scoreThreshold: typeof r.scoreThreshold === "number" ? r.scoreThreshold : DEFAULT_CONFIG.recall.scoreThreshold,
      maxContextChars: num(r.maxContextChars, DEFAULT_CONFIG.recall.maxContextChars),
      cacheTtlMs: num(r.cacheTtlMs, DEFAULT_CONFIG.recall.cacheTtlMs),
      cacheMaxSize: num(r.cacheMaxSize, DEFAULT_CONFIG.recall.cacheMaxSize),
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
