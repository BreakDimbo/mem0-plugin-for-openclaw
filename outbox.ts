// ============================================================================
// Outbox: async write-back queue with persistence + dead-letter
// Phase 2: JSON file persistence, batchSize, drainTimeoutMs, dead-letter log
// ============================================================================

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { homedir } from "node:os";
import type { OutboxItem, DeadLetterItem, MemoryScope } from "./types.js";
import type { FreeTextBackend } from "./backends/free-text/base.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

type OutboxRecentEvent = {
  type: "enqueued" | "sent" | "retry" | "dead-letter";
  id: string;
  at: number;
  agentId?: string;
  retryCount?: number;
  error?: string;
};

const BACKOFF_DELAYS = [1_000, 5_000, 30_000, 120_000];

export class OutboxWorker {
  private queue: OutboxItem[] = [];
  private deadLetters: DeadLetterItem[] = [];
  private loaded = false;
  private primaryBackend: FreeTextBackend;
  private secondaryBackend: FreeTextBackend | null;
  private logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private flushPromise: Promise<void> | null = null;

  private readonly concurrency: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly persistPath: string;
  private readonly flushIntervalMs: number;

  // Stats
  private _sent = 0;
  private _failed = 0;
  private _lastSentAt: number | null = null;
  private _lastFailedAt: number | null = null;
  private _lastEnqueuedAt: number | null = null;
  private recentEvents: OutboxRecentEvent[] = [];

  constructor(
    primaryBackend: FreeTextBackend,
    logger: Logger,
    opts: {
      concurrency: number;
      batchSize: number;
      maxRetries: number;
      persistPath: string;
      flushIntervalMs?: number;
      secondaryBackend?: FreeTextBackend | null;
    },
  ) {
    this.primaryBackend = primaryBackend;
    this.secondaryBackend = opts.secondaryBackend ?? null;
    this.logger = logger;
    this.concurrency = opts.concurrency;
    this.batchSize = opts.batchSize;
    this.maxRetries = opts.maxRetries;
    this.persistPath = opts.persistPath.replace(/^~/, homedir());
    this.flushIntervalMs = opts.flushIntervalMs ?? 10_000;
  }

  private makeId(text: string, scope: MemoryScope): string {
    const bucket = Math.floor(Date.now() / 60_000);
    const input = `${scope.sessionKey}:${text}:${bucket}`;
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
  }

  // -- Persistence --

  private get queueFilePath(): string {
    return this.persistPath ? `${this.persistPath}/outbox-queue.json` : "";
  }

  private get deadLetterFilePath(): string {
    return this.persistPath ? `${this.persistPath}/outbox-deadletter.json` : "";
  }

  private async readQueueFile(filePath: string): Promise<OutboxItem[]> {
    try {
      const data = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private mergeQueueItems(items: OutboxItem[]): void {
    const seen = new Set(this.queue.map((item) => item.id));
    for (const item of items) {
      if (!item || typeof item !== "object" || typeof item.id !== "string") {
        continue;
      }
      if (seen.has(item.id)) {
        continue;
      }
      this.queue.push(item);
      seen.add(item.id);
    }
  }

  private async clearQueueFile(filePath: string): Promise<void> {
    try {
      await writeFile(filePath, "[]", "utf-8");
    } catch (err) {
      this.logger.warn(`outbox: failed to clear legacy shard ${basename(filePath)}: ${String(err)}`);
    }
  }

  private pushRecentEvent(event: OutboxRecentEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > 10) {
      this.recentEvents.splice(0, this.recentEvents.length - 10);
    }
  }

  async loadFromDisk(): Promise<void> {
    if (!this.queueFilePath) return;

    this.queue = [];

    const primaryItems = await this.readQueueFile(this.queueFilePath);
    this.mergeQueueItems(primaryItems);

    try {
      const fileNames = await readdir(dirname(this.queueFilePath));
      const legacyShardFiles = fileNames
        .filter((name) => name.startsWith("outbox-queue-") && name.endsWith(".json"))
        .map((name) => `${dirname(this.queueFilePath)}/${name}`);

      for (const filePath of legacyShardFiles) {
        const shardItems = await this.readQueueFile(filePath);
        if (shardItems.length > 0) {
          this.mergeQueueItems(shardItems);
          this.logger.warn(`outbox: merged ${shardItems.length} pending items from legacy shard ${basename(filePath)}`);
          await this.clearQueueFile(filePath);
        }
      }
    } catch {
      // Ignore shard scan failures; primary queue file is still authoritative
    }

    try {
      const data = await readFile(this.deadLetterFilePath, "utf-8");
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this.deadLetters = parsed;
      }
    } catch {
      // Start fresh
    }

    this.loaded = true;
    this.logger.info(`outbox: loaded ${this.queue.length} items from disk`);
  }

  private async saveToDisk(): Promise<void> {
    if (!this.queueFilePath) return;
    if (!this.loaded) {
      this.logger.warn("outbox: save skipped before initial load completed");
      return;
    }

    try {
      await mkdir(dirname(this.queueFilePath), { recursive: true });
      await writeFile(this.queueFilePath, JSON.stringify(this.queue, null, 2), "utf-8");
    } catch (err) {
      this.logger.warn(`outbox: failed to persist queue: ${String(err)}`);
    }
  }

  private async saveDeadLetters(): Promise<void> {
    if (!this.deadLetterFilePath) return;

    try {
      await mkdir(dirname(this.deadLetterFilePath), { recursive: true });
      await writeFile(this.deadLetterFilePath, JSON.stringify(this.deadLetters, null, 2), "utf-8");
    } catch (err) {
      this.logger.warn(`outbox: failed to persist dead-letters: ${String(err)}`);
    }
  }

  // -- Enqueue --

  enqueue(text: string, scope: MemoryScope, metadata?: Record<string, unknown>): void {
    const id = this.makeId(text, scope);

    // Dedup: skip if already queued with same id
    if (this.queue.some((item) => item.id === id)) {
      this.logger.info(`outbox: dedup skip id=${id}`);
      return;
    }

    this.queue.push({
      id,
      createdAt: Date.now(),
      scope,
      payload: { text, metadata },
      retryCount: 0,
      nextRetryAt: 0,
    });
    this._lastEnqueuedAt = Date.now();
    this.pushRecentEvent({ type: "enqueued", id, at: this._lastEnqueuedAt, agentId: scope.agentId });

    this.logger.info(`outbox: enqueued id=${id} (queue size: ${this.queue.length})`);

    // Async persist, don't block
    this.saveToDisk().catch(() => {});

    // Kick off an immediate background flush so fresh stores do not appear
    // "stuck" while waiting for the next interval tick.
    this.flush().catch((err) => {
      this.logger.warn(`outbox: immediate flush error: ${String(err)}`);
    });
  }

  // -- Flush --

  async flush(): Promise<void> {
    if (this.flushing && this.flushPromise) return this.flushPromise;
    this.flushing = true;
    this.flushPromise = (async () => {
      try {
      const now = Date.now();
      const ready = this.queue.filter((item) => item.nextRetryAt <= now);
      if (ready.length === 0) return;

      // Take up to batchSize items, process with concurrency parallelism
      const batch = ready.slice(0, this.batchSize);
      let changed = false;

      // Process in concurrency-limited chunks
      for (let offset = 0; offset < batch.length; offset += this.concurrency) {
        const chunk = batch.slice(offset, offset + this.concurrency);

        const results = await Promise.allSettled(
          chunk.map(async (item) => {
            const ok = await this.primaryBackend.store(item.payload.text, item.scope, {
              metadata: item.payload.metadata,
              sessionScoped: false,
            });
            if (!ok) throw new Error("memorize returned false");
            if (this.secondaryBackend) {
              const secondaryOk = await this.secondaryBackend.store(item.payload.text, item.scope, {
                metadata: item.payload.metadata,
                sessionScoped: false,
              });
              if (!secondaryOk) {
                this.logger.warn(`outbox: secondary backend store failed id=${item.id} provider=${this.secondaryBackend.provider}`);
              }
            }
            return item.id;
          }),
        );

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const item = chunk[i];

          if (result.status === "fulfilled") {
            const idx = this.queue.findIndex((q) => q.id === item.id);
            if (idx !== -1) this.queue.splice(idx, 1);
            this._sent++;
            this._lastSentAt = Date.now();
            changed = true;
            this.pushRecentEvent({ type: "sent", id: item.id, at: this._lastSentAt, agentId: item.scope.agentId });
            this.logger.info(`outbox: sent id=${item.id}`);
          } else {
            item.retryCount++;
            if (item.retryCount >= this.maxRetries) {
              // Move to dead-letter
              const idx = this.queue.findIndex((q) => q.id === item.id);
              if (idx !== -1) this.queue.splice(idx, 1);
              this._failed++;
              this._lastFailedAt = Date.now();
              changed = true;

              const dlItem: DeadLetterItem = {
                ...item,
                failedAt: Date.now(),
                lastError: result.status === "rejected" ? String(result.reason) : "unknown",
              };
              this.deadLetters.push(dlItem);
              await this.saveDeadLetters();
              this.pushRecentEvent({
                type: "dead-letter",
                id: item.id,
                at: this._lastFailedAt,
                agentId: item.scope.agentId,
                retryCount: item.retryCount,
                error: dlItem.lastError,
              });

              this.logger.warn(`outbox: dead-letter id=${item.id} after ${item.retryCount} retries: ${dlItem.lastError}`);
            } else {
              const delay = BACKOFF_DELAYS[Math.min(item.retryCount - 1, BACKOFF_DELAYS.length - 1)];
              item.nextRetryAt = Date.now() + delay;
              changed = true;
              this.pushRecentEvent({
                type: "retry",
                id: item.id,
                at: Date.now(),
                agentId: item.scope.agentId,
                retryCount: item.retryCount,
              });
              this.logger.warn(`outbox: retry id=${item.id} attempt=${item.retryCount} next_in=${delay}ms`);
            }
          }
        }
      }

      if (changed) {
        await this.saveToDisk();
      }
      } finally {
        this.flushing = false;
        this.flushPromise = null;
      }
    })();
    return this.flushPromise;
  }

  // -- Lifecycle --

  async start(): Promise<void> {
    await this.loadFromDisk();

    if (this.timer) return;
    await this.flush();
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        this.logger.warn(`outbox: flush error: ${String(err)}`);
      });
    }, this.flushIntervalMs);
    this.logger.info(`outbox: worker started (interval: ${this.flushIntervalMs}ms, persisted: ${this.queue.length})`);
  }

  async drain(timeoutMs?: number): Promise<void> {
    const deadline = Date.now() + (timeoutMs ?? 5_000);
    let attempts = 0;

    while (this.queue.length > 0 && Date.now() < deadline && attempts < 20) {
      await this.flush();
      attempts++;
      if (this.queue.length > 0) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (this.queue.length > 0) {
      this.logger.warn(`outbox: drain incomplete, ${this.queue.length} items remaining`);
    }

    // Final persist
    await this.saveToDisk();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.loaded = false;
    this.logger.info(`outbox: worker stopped (sent: ${this._sent}, failed: ${this._failed}, pending: ${this.queue.length})`);
  }

  // -- Accessors --

  get pending(): number {
    return this.queue.length;
  }

  get sent(): number {
    return this._sent;
  }

  get failed(): number {
    return this._failed;
  }

  get deadLetterCount(): number {
    return this.deadLetters.length;
  }

  get lastSentAt(): number | null {
    return this._lastSentAt;
  }

  get lastFailedAt(): number | null {
    return this._lastFailedAt;
  }

  get lastEnqueuedAt(): number | null {
    return this._lastEnqueuedAt;
  }

  get oldestPendingAgeMs(): number | null {
    if (this.queue.length === 0) return null;
    const oldestCreatedAt = this.queue.reduce((min, item) => Math.min(min, item.createdAt), this.queue[0]?.createdAt ?? Date.now());
    return Math.max(0, Date.now() - oldestCreatedAt);
  }

  get recent(): OutboxRecentEvent[] {
    return [...this.recentEvents];
  }
}
