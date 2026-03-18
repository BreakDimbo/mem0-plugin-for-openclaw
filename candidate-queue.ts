// ============================================================================
// CandidateQueue: buffered queue for capture candidates with configurable timer
// Collects user messages from message_received, processes in batch via callback.
// Modeled after OutboxWorker pattern (persistence, start/stop/drain lifecycle).
// ============================================================================

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { MemoryScope, ConversationMessage } from "./types.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

export type CandidateItem = {
  id: string;
  messages: ConversationMessage[];
  scope: MemoryScope;
  receivedAt: number;
  metadata?: Record<string, unknown>;
};

type LegacyCandidateItem = {
  id?: string;
  text?: string;
  scope?: MemoryScope;
  receivedAt?: number;
  metadata?: Record<string, unknown>;
};

export type CandidateProcessor = (batch: CandidateItem[]) => Promise<void>;

export class CandidateQueue {
  private queue: CandidateItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private loaded = false;
  private processing = false;

  private readonly intervalMs: number;
  private readonly maxBatchSize: number;
  private readonly persistPath: string;
  private readonly processor: CandidateProcessor;
  private readonly logger: Logger;

  // Dedup: track recent text hashes to avoid enqueueing duplicates
  private readonly recentHashes = new Set<string>();
  private static readonly MAX_RECENT_HASHES = 200;

  // Stats
  private _enqueued = 0;
  private _processed = 0;
  private _dropped = 0;

  constructor(
    processor: CandidateProcessor,
    logger: Logger,
    opts: {
      intervalMs: number;
      maxBatchSize: number;
      persistPath: string;
    },
  ) {
    this.processor = processor;
    this.logger = logger;
    this.intervalMs = opts.intervalMs;
    this.maxBatchSize = opts.maxBatchSize;
    this.persistPath = opts.persistPath.replace(/^~/, homedir());
  }

  private get filePath(): string {
    return this.persistPath ? `${this.persistPath}/candidate-queue.json` : "";
  }

  private normalizePersistedItem(item: unknown): CandidateItem | null {
    if (!item || typeof item !== "object") return null;
    const record = item as Partial<CandidateItem> & LegacyCandidateItem;
    const scope = record.scope;
    if (!scope || typeof scope.userId !== "string" || typeof scope.agentId !== "string" || typeof scope.sessionKey !== "string") {
      return null;
    }

    const messages = Array.isArray(record.messages)
      ? record.messages.filter(
          (msg): msg is ConversationMessage =>
            !!msg &&
            (msg.role === "user" || msg.role === "assistant") &&
            typeof msg.content === "string" &&
            msg.content.trim().length > 0,
        )
      : typeof record.text === "string" && record.text.trim().length > 0
        ? [{ role: "user" as const, content: record.text.trim() }]
        : [];

    if (messages.length === 0) return null;

    const id = typeof record.id === "string" && record.id.trim()
      ? record.id
      : this.makeId(messages, scope);

    return {
      id,
      messages,
      scope,
      receivedAt: typeof record.receivedAt === "number" ? record.receivedAt : Date.now(),
      metadata: record.metadata,
    };
  }

  private makeId(messages: ConversationMessage[], scope: MemoryScope): string {
    // Hash concatenation of message contents for dedup
    const content = messages.map(m => `${m.role}:${m.content}`).join("|");
    const input = `${scope.userId}:${scope.agentId}:${content}`;
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
  }

  // -- Persistence --

  private async loadFromDisk(): Promise<void> {
    if (!this.filePath) return;
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const normalized = this.normalizePersistedItem(item);
          if (!normalized) continue;
          this.queue.push(normalized);
          this.recentHashes.add(normalized.id);
        }
      }
      this.logger.info(`candidate-queue: loaded ${this.queue.length} items from disk`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn(`candidate-queue: load error: ${String(err)}`);
      }
    }
    this.loaded = true;
  }

  private async saveToDisk(): Promise<void> {
    if (!this.filePath || !this.loaded) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.queue, null, 2), "utf-8");
    } catch (err) {
      this.logger.warn(`candidate-queue: persist error: ${String(err)}`);
    }
  }

  // -- Enqueue --

  enqueue(messages: ConversationMessage[], scope: MemoryScope, metadata?: Record<string, unknown>): void {
    if (messages.length === 0) return;
    const id = this.makeId(messages, scope);

    // Dedup
    if (this.recentHashes.has(id)) {
      this._dropped++;
      return;
    }

    this.queue.push({
      id,
      messages,
      scope,
      receivedAt: Date.now(),
      metadata,
    });

    this.recentHashes.add(id);
    if (this.recentHashes.size > CandidateQueue.MAX_RECENT_HASHES) {
      const first = this.recentHashes.values().next().value;
      if (first) this.recentHashes.delete(first);
    }

    this._enqueued++;
    this.logger.info(`candidate-queue: enqueued id=${id} (queue=${this.queue.length})`);

    // Async persist
    this.saveToDisk().catch(() => {});
  }

  // -- Batch processing --

  async processBatch(): Promise<void> {
    if (this.processing) return;
    if (this.queue.length === 0) return;

    this.processing = true;
    try {
      const batch = this.queue.splice(0, this.maxBatchSize);
      this.logger.info(`candidate-queue: processing batch of ${batch.length} items`);

      await this.processor(batch);

      this._processed += batch.length;
      await this.saveToDisk();

      this.logger.info(`candidate-queue: batch complete (processed=${this._processed}, remaining=${this.queue.length})`);
    } catch (err) {
      this.logger.warn(`candidate-queue: batch error: ${String(err)}`);
      // Items already spliced — they are lost on error. This is acceptable:
      // candidates are best-effort, and retrying stale messages adds complexity
      // for little benefit. The next batch of fresh messages will be captured.
    } finally {
      this.processing = false;
    }
  }

  // -- Lifecycle --

  async start(): Promise<void> {
    await this.loadFromDisk();

    if (this.timer) return;

    // Process any persisted items immediately
    if (this.queue.length > 0) {
      await this.processBatch();
    }

    this.timer = setInterval(() => {
      this.processBatch().catch((err) => {
        this.logger.warn(`candidate-queue: timer error: ${String(err)}`);
      });
    }, this.intervalMs);

    this.logger.info(`candidate-queue: started (interval=${this.intervalMs}ms, persisted=${this.queue.length})`);
  }

  async drain(timeoutMs?: number): Promise<void> {
    const deadline = Date.now() + (timeoutMs ?? 5_000);
    let attempts = 0;

    while (this.queue.length > 0 && Date.now() < deadline && attempts < 20) {
      await this.processBatch();
      attempts++;
      if (this.queue.length > 0) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (this.queue.length > 0) {
      this.logger.warn(`candidate-queue: drain incomplete, ${this.queue.length} items remaining`);
    }

    await this.saveToDisk();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.loaded = false;
    this.logger.info(`candidate-queue: stopped (enqueued=${this._enqueued}, processed=${this._processed}, dropped=${this._dropped}, pending=${this.queue.length})`);
  }

  // -- Accessors --

  get pending(): number {
    return this.queue.length;
  }

  get enqueued(): number {
    return this._enqueued;
  }

  get processed(): number {
    return this._processed;
  }

  get dropped(): number {
    return this._dropped;
  }
}
