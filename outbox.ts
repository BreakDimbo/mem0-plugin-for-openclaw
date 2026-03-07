// ============================================================================
// Outbox: async write-back queue with persistence + dead-letter
// Phase 2: JSON file persistence, batchSize, drainTimeoutMs, dead-letter log
// ============================================================================

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { MemUAdapter } from "./adapter.js";
import type { OutboxItem, DeadLetterItem, MemoryScope } from "./types.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

const BACKOFF_DELAYS = [1_000, 5_000, 30_000, 120_000];

export class OutboxWorker {
  private queue: OutboxItem[] = [];
  private deadLetters: DeadLetterItem[] = [];
  private adapter: MemUAdapter;
  private logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  private readonly concurrency: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly persistPath: string;
  private readonly flushIntervalMs: number;

  // Stats
  private _sent = 0;
  private _failed = 0;

  constructor(
    adapter: MemUAdapter,
    logger: Logger,
    opts: {
      concurrency: number;
      batchSize: number;
      maxRetries: number;
      persistPath: string;
      flushIntervalMs?: number;
    },
  ) {
    this.adapter = adapter;
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

  async loadFromDisk(): Promise<void> {
    if (!this.queueFilePath) return;

    try {
      const data = await readFile(this.queueFilePath, "utf-8");
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this.queue = parsed;
        this.logger.info(`outbox: loaded ${this.queue.length} items from disk`);
      }
    } catch {
      // File doesn't exist yet or corrupted — start fresh
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
  }

  private async saveToDisk(): Promise<void> {
    if (!this.queueFilePath) return;

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

    this.logger.info(`outbox: enqueued id=${id} (queue size: ${this.queue.length})`);

    // Async persist, don't block
    this.saveToDisk().catch(() => {});
  }

  // -- Flush --

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

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
            const ok = await this.adapter.memorize(item.payload.text, item.scope, item.payload.metadata);
            if (!ok) throw new Error("memorize returned false");
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
            changed = true;
            this.logger.info(`outbox: sent id=${item.id}`);
          } else {
            item.retryCount++;
            if (item.retryCount >= this.maxRetries) {
              // Move to dead-letter
              const idx = this.queue.findIndex((q) => q.id === item.id);
              if (idx !== -1) this.queue.splice(idx, 1);
              this._failed++;
              changed = true;

              const dlItem: DeadLetterItem = {
                ...item,
                failedAt: Date.now(),
                lastError: result.status === "rejected" ? String(result.reason) : "unknown",
              };
              this.deadLetters.push(dlItem);
              this.saveDeadLetters().catch(() => {});

              this.logger.warn(`outbox: dead-letter id=${item.id} after ${item.retryCount} retries: ${dlItem.lastError}`);
            } else {
              const delay = BACKOFF_DELAYS[Math.min(item.retryCount - 1, BACKOFF_DELAYS.length - 1)];
              item.nextRetryAt = Date.now() + delay;
              changed = true;
              this.logger.warn(`outbox: retry id=${item.id} attempt=${item.retryCount} next_in=${delay}ms`);
            }
          }
        }
      }

      if (changed) {
        this.saveToDisk().catch(() => {});
      }
    } finally {
      this.flushing = false;
    }
  }

  // -- Lifecycle --

  async start(): Promise<void> {
    await this.loadFromDisk();

    if (this.timer) return;
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
}
