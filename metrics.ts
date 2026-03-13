// ============================================================================
// Metrics: structured counters + latency tracking
// Phase 3: observable recall/capture/outbox/cache stats
// ============================================================================

export type MetricSnapshot = {
  recall: {
    total: number;
    hits: number;
    misses: number;
    errors: number;
    avgLatencyMs: number;
  };
  capture: {
    total: number;
    captured: number;
    filtered: number;
    deduped: number;
  };
  outbox: {
    sent: number;
    failed: number;
    pending: number;
    deadLetters: number;
    oldestPendingAgeMs: number | null;
    lastSentAt: number | null;
    lastFailedAt: number | null;
  };
  cache: {
    size: number;
    hits: number;
    misses: number;
    hitRate: number;
  };
  client: {
    totalRequests: number;
    totalErrors: number;
    circuitState: string;
    latencyP50: number;
    latencyP95: number;
    latencyP99: number;
  };
  uptime: number;
};

export class Metrics {
  private startTime = Date.now();

  // Recall
  recallTotal = 0;
  recallHits = 0;
  recallMisses = 0;
  recallErrors = 0;
  private recallLatencies: number[] = [];

  // Capture
  captureTotal = 0;
  captureCaptured = 0;
  captureFiltered = 0;
  captureDeduped = 0;

  recordRecallLatency(ms: number): void {
    this.recallLatencies.push(ms);
    if (this.recallLatencies.length > 200) {
      this.recallLatencies.splice(0, this.recallLatencies.length - 200);
    }
  }

  get avgRecallLatencyMs(): number {
    if (this.recallLatencies.length === 0) return 0;
    const sum = this.recallLatencies.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.recallLatencies.length);
  }

  get uptimeMs(): number {
    return Date.now() - this.startTime;
  }

  snapshot(deps: {
    outbox: {
      sent: number;
      failed: number;
      pending: number;
      deadLetterCount: number;
      oldestPendingAgeMs: number | null;
      lastSentAt: number | null;
      lastFailedAt: number | null;
    };
    cache: { size: number; hits: number; misses: number; hitRate: number };
    client: {
      totalRequests: number;
      totalErrors: number;
      circuitState: string;
      latencyStats: { p50: number; p95: number; p99: number };
    };
  }): MetricSnapshot {
    return {
      recall: {
        total: this.recallTotal,
        hits: this.recallHits,
        misses: this.recallMisses,
        errors: this.recallErrors,
        avgLatencyMs: this.avgRecallLatencyMs,
      },
      capture: {
        total: this.captureTotal,
        captured: this.captureCaptured,
        filtered: this.captureFiltered,
        deduped: this.captureDeduped,
      },
      outbox: {
        sent: deps.outbox.sent,
        failed: deps.outbox.failed,
        pending: deps.outbox.pending,
        deadLetters: deps.outbox.deadLetterCount,
        oldestPendingAgeMs: deps.outbox.oldestPendingAgeMs,
        lastSentAt: deps.outbox.lastSentAt,
        lastFailedAt: deps.outbox.lastFailedAt,
      },
      cache: {
        size: deps.cache.size,
        hits: deps.cache.hits,
        misses: deps.cache.misses,
        hitRate: deps.cache.hitRate,
      },
      client: {
        totalRequests: deps.client.totalRequests,
        totalErrors: deps.client.totalErrors,
        circuitState: deps.client.circuitState,
        latencyP50: deps.client.latencyStats.p50,
        latencyP95: deps.client.latencyStats.p95,
        latencyP99: deps.client.latencyStats.p99,
      },
      uptime: this.uptimeMs,
    };
  }

  formatDashboard(snap: MetricSnapshot): string {
    const uptimeSec = Math.floor(snap.uptime / 1000);
    const uptimeMin = Math.floor(uptimeSec / 60);
    const uptimeStr = uptimeMin > 0 ? `${uptimeMin}m ${uptimeSec % 60}s` : `${uptimeSec}s`;

    return [
      "memU Memory Plugin Dashboard",
      "════════════════════════════════",
      "",
      `Uptime: ${uptimeStr}`,
      "",
      "Recall:",
      `  Total:      ${snap.recall.total}`,
      `  Cache Hits: ${snap.recall.hits}`,
      `  Fetched:    ${snap.recall.misses}`,
      `  Errors:     ${snap.recall.errors}`,
      `  Avg Latency: ${snap.recall.avgLatencyMs}ms`,
      "",
      "Capture:",
      `  Total Evaluated: ${snap.capture.total}`,
      `  Captured:        ${snap.capture.captured}`,
      `  Filtered:        ${snap.capture.filtered}`,
      `  Deduped:         ${snap.capture.deduped}`,
      "",
      "Outbox:",
      `  Sent:         ${snap.outbox.sent}`,
      `  Failed:       ${snap.outbox.failed}`,
      `  Pending:      ${snap.outbox.pending}`,
      `  Dead Letters: ${snap.outbox.deadLetters}`,
      `  Oldest Pending Age: ${snap.outbox.oldestPendingAgeMs === null ? "none" : `${Math.round(snap.outbox.oldestPendingAgeMs / 1000)}s`}`,
      `  Last Sent:    ${snap.outbox.lastSentAt ? new Date(snap.outbox.lastSentAt).toISOString() : "never"}`,
      `  Last Failed:  ${snap.outbox.lastFailedAt ? new Date(snap.outbox.lastFailedAt).toISOString() : "never"}`,
      "",
      "Cache:",
      `  Size:     ${snap.cache.size}`,
      `  Hit Rate: ${(snap.cache.hitRate * 100).toFixed(1)}% (${snap.cache.hits} hits, ${snap.cache.misses} misses)`,
      "",
      "Client:",
      `  Total Requests: ${snap.client.totalRequests}`,
      `  Total Errors:   ${snap.client.totalErrors}`,
      `  Circuit Breaker: ${snap.client.circuitState}`,
      `  Latency P50: ${snap.client.latencyP50}ms  P95: ${snap.client.latencyP95}ms  P99: ${snap.client.latencyP99}ms`,
    ].join("\n");
  }
}
