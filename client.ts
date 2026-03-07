// ============================================================================
// memU HTTP Client with Circuit Breaker
// Phase 2: FAILURE_THRESHOLD=3, configurable healthCheckPath
// Aligned with §8 API contracts
// ============================================================================

import type {
  CircuitState,
  MemuRetrieveResponse,
  MemuMemorizeResponse,
  MemuClearResponse,
  MemuCategoriesResponse,
} from "./types.js";

export type RetrieveParams = {
  query: string;
  where?: Record<string, unknown>;
  method?: "rag" | "llm";
  limit?: number;
};

export type MemorizeParams = {
  content: Array<{ role: string; content: { text: string }; created_at?: string }>;
  metadata?: Record<string, unknown>;
  resourceUrl?: string;
  modality?: string;
  user?: { user_id: string };
};

type Logger = { info(msg: string): void; warn(msg: string): void };

export class MemUClient {
  private baseUrl: string;
  private timeoutMs: number;
  private cbResetMs: number;
  private healthCheckPath: string;
  private logger: Logger;

  // Circuit breaker state
  private cbState: CircuitState = "closed";
  private cbFailCount = 0;
  private cbLastFailTime = 0;
  private readonly cbThreshold = 3; // per design doc §14
  private cbHalfOpenProbeInFlight = false;

  // Request metrics
  private _totalRequests = 0;
  private _totalErrors = 0;
  private _latencies: number[] = [];
  private readonly maxLatencySamples = 200;
  private readonly maxAttempts = 2;

  constructor(baseUrl: string, timeoutMs: number, cbResetMs: number, healthCheckPath: string, logger: Logger) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.cbResetMs = cbResetMs;
    this.healthCheckPath = healthCheckPath;
    this.logger = logger;
  }

  get circuitState(): CircuitState {
    return this.cbState;
  }

  get failCount(): number {
    return this.cbFailCount;
  }

  get totalRequests(): number {
    return this._totalRequests;
  }

  get totalErrors(): number {
    return this._totalErrors;
  }

  get latencyStats(): { p50: number; p95: number; p99: number; count: number } {
    const sorted = [...this._latencies].sort((a, b) => a - b);
    const len = sorted.length;
    if (len === 0) return { p50: 0, p95: 0, p99: 0, count: 0 };
    return {
      p50: sorted[Math.floor(len * 0.5)] ?? 0,
      p95: sorted[Math.floor(len * 0.95)] ?? 0,
      p99: sorted[Math.floor(len * 0.99)] ?? 0,
      count: len,
    };
  }

  // -- Circuit Breaker --

  private checkCircuit(): boolean {
    if (this.cbState === "closed") return true;

    if (this.cbState === "open") {
      if (Date.now() - this.cbLastFailTime >= this.cbResetMs) {
        this.cbState = "half-open";
        this.cbHalfOpenProbeInFlight = false;
        this.logger.info("memu-client: circuit breaker → half-open");
        return true;
      }
      return false;
    }

    // half-open: allow only one probe request at a time
    if (this.cbHalfOpenProbeInFlight) return false;
    this.cbHalfOpenProbeInFlight = true;
    return true;
  }

  private onSuccess(): void {
    if (this.cbState === "closed" && this.cbFailCount > 0) {
      this.cbFailCount = 0;
    }
    if (this.cbState === "half-open") {
      this.cbState = "closed";
      this.cbFailCount = 0;
      this.cbHalfOpenProbeInFlight = false;
      this.logger.info("memu-client: circuit breaker → closed");
    }
  }

  private onFailure(): void {
    this.cbFailCount++;
    this._totalErrors++;
    this.cbLastFailTime = Date.now();
    if (this.cbState === "half-open") {
      this.cbState = "open";
      this.cbHalfOpenProbeInFlight = false;
      this.logger.warn("memu-client: circuit breaker → open (half-open failed)");
    } else if (this.cbFailCount >= this.cbThreshold) {
      this.cbState = "open";
      this.logger.warn(`memu-client: circuit breaker → open (${this.cbFailCount} failures)`);
    }
  }

  private recordLatency(ms: number): void {
    this._latencies.push(ms);
    if (this._latencies.length > this.maxLatencySamples) {
      this._latencies.splice(0, this._latencies.length - this.maxLatencySamples);
    }
  }

  // -- HTTP --

  private async request<T>(path: string, body: unknown): Promise<T> {
    if (!this.checkCircuit()) {
      throw new Error(`circuit breaker is ${this.cbState} (${this.cbFailCount} failures)`);
    }

    this._totalRequests++;
    const start = Date.now();
    let lastErr: unknown;
    let lastWasAbort = false;
    try {
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const res = await fetch(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
          }

          const data = (await res.json()) as T;
          lastErr = undefined;
          lastWasAbort = false;
          this.onSuccess();
          return data;
        } catch (err) {
          lastErr = err;
          lastWasAbort = (err as { name?: string } | null)?.name === "AbortError";
          const msg = String((err as { message?: string } | null)?.message ?? "");
          const retryableHttp = /HTTP (408|429|500|502|503|504)\b/.test(msg);
          const canRetry = attempt < this.maxAttempts && (lastWasAbort || retryableHttp);
          if (canRetry) {
            this.logger.warn(`memu-client: ${path} attempt ${attempt} failed, retrying once`);
            await new Promise((resolve) => setTimeout(resolve, 200));
            continue;
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastErr ?? new Error(`memu request failed (${path})`);
    } finally {
      this.recordLatency(Date.now() - start);
      if (lastErr) {
        this.onFailure();
      }
      if (lastWasAbort) {
        throw new Error(`memu request timeout after ${this.timeoutMs}ms (${path})`);
      }
      if (this.cbState === "half-open") {
        this.cbHalfOpenProbeInFlight = false;
      }
    }
  }

  // -- Public API --

  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(`${this.baseUrl}${this.healthCheckPath}`, { signal: controller.signal });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  async retrieve(params: RetrieveParams): Promise<MemuRetrieveResponse> {
    const body: Record<string, unknown> = {
      query: params.query,  // memU server expects "query", not "queries"
    };
    if (params.where && Object.keys(params.where).length > 0) {
      body.where = params.where;
    }
    if (params.method) {
      body.method = params.method;
    }
    if (params.limit !== undefined) {
      body.limit = params.limit;
    }
    return this.request<MemuRetrieveResponse>("/retrieve", body);
  }

  async memorize(params: MemorizeParams): Promise<MemuMemorizeResponse> {
    const body: Record<string, unknown> = {
      content: params.content,
    };
    if (params.resourceUrl) {
      body.resource_url = params.resourceUrl;
    }
    if (params.modality) {
      body.modality = params.modality;
    }
    if (params.user) {
      body.user = params.user;
    }
    if (params.metadata && Object.keys(params.metadata).length > 0) {
      body.metadata = params.metadata;
    }
    return this.request<MemuMemorizeResponse>("/memorize", body);
  }

  async clear(userId?: string, agentId?: string): Promise<MemuClearResponse> {
    const body: Record<string, string> = {};
    if (userId) body.user_id = userId;
    if (agentId) body.agent_id = agentId;
    return this.request<MemuClearResponse>("/clear", body);
  }

  async categories(userId: string, agentId?: string): Promise<MemuCategoriesResponse> {
    const body: Record<string, string> = { user_id: userId };
    if (agentId) body.agent_id = agentId;
    return this.request<MemuCategoriesResponse>("/categories", body);
  }
}
