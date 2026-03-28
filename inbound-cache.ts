import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";

import type { ClassificationResult } from "./types.js";

type InboundEntry = {
  content: string;
  ts: number;
  classification?: ClassificationResult;
};

type InboundStore = {
  bySender: Record<string, InboundEntry>;
};

const EMPTY_STORE: InboundStore = {
  bySender: {},
};

export class InboundMessageCache {
  private readonly filePath: string;
  private readonly readCacheTtlMs: number;
  private lastReadAt = 0;
  private mem: InboundStore = EMPTY_STORE;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    filePath: string,
    private readonly ttlMs = 2 * 60_000,
    private readonly maxSize = 500,
    readCacheTtlMs = 150,
  ) {
    this.filePath = filePath.replace(/^~/, homedir());
    this.readCacheTtlMs = readCacheTtlMs;
  }

  private now(): number {
    return Date.now();
  }

  private makeSenderKey(channelId: string, senderId: string): string {
    return `${channelId}::${senderId}`;
  }

  private normalizeSenderVariants(senderId: string): string[] {
    const raw = senderId.trim();
    if (!raw) return [];
    const variants = new Set<string>([raw]);
    const idx = raw.indexOf(":");
    if (idx > 0 && idx < raw.length - 1) {
      variants.add(raw.slice(idx + 1));
    } else {
      variants.add(`feishu:${raw}`);
    }
    return Array.from(variants);
  }

  private sweep(store: InboundStore): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of Object.entries(store.bySender)) {
      if (!v || typeof v.ts !== "number" || v.ts < cutoff) delete store.bySender[k];
    }
  }

  private clampRecord(map: Record<string, InboundEntry>): Record<string, InboundEntry> {
    const entries = Object.entries(map);
    if (entries.length <= this.maxSize) return map;
    entries.sort((a, b) => a[1].ts - b[1].ts);
    const trimmed = entries.slice(entries.length - this.maxSize);
    return Object.fromEntries(trimmed);
  }

  private clamp(store: InboundStore): void {
    store.bySender = this.clampRecord(store.bySender);
  }

  private cloneStore(store: InboundStore): InboundStore {
    return {
      bySender: { ...store.bySender },
    };
  }

  private parseStore(raw: string): InboundStore {
    try {
      const parsed = JSON.parse(raw) as Partial<InboundStore>;
      const store: InboundStore = {
        bySender: typeof parsed.bySender === "object" && parsed.bySender && !Array.isArray(parsed.bySender) ? (parsed.bySender as Record<string, InboundEntry>) : {},
      };
      this.sweep(store);
      this.clamp(store);
      return store;
    } catch {
      return this.cloneStore(EMPTY_STORE);
    }
  }

  private async loadStore(force = false): Promise<InboundStore> {
    const now = this.now();
    if (!force && now - this.lastReadAt <= this.readCacheTtlMs) return this.mem;

    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.mem = this.parseStore(raw);
    } catch {
      this.mem = this.cloneStore(EMPTY_STORE);
    }
    this.lastReadAt = now;
    return this.mem;
  }

  private async persistStore(store: InboundStore): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(store), "utf-8");
    await rename(tmpPath, this.filePath);
  }

  private async queueWrite(mutator: (store: InboundStore) => void): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const store = this.cloneStore(await this.loadStore(true));
      mutator(store);
      this.sweep(store);
      this.clamp(store);
      await this.persistStore(store);
      this.mem = store;
      this.lastReadAt = this.now();
    });
    return this.writeChain;
  }

  async set(channelId: string, senderId: string | undefined, content: string): Promise<void> {
    const text = content.trim();
    if (!channelId || !text) return;
    const ts = this.now();

    await this.queueWrite((store) => {
      const entry: InboundEntry = { content: text, ts };
      if (senderId?.trim()) {
        for (const sid of this.normalizeSenderVariants(senderId)) {
          store.bySender[this.makeSenderKey(channelId, sid)] = entry;
        }
      }
    });
  }

  async getBySender(channelId: string, senderId: string): Promise<string | undefined> {
    const store = await this.loadStore();
    for (const sid of this.normalizeSenderVariants(senderId)) {
      const hit = store.bySender[this.makeSenderKey(channelId, sid)];
      if (hit?.content) return hit.content;
    }
    return undefined;
  }

  async setClassification(channelId: string, senderId: string | undefined, classification: ClassificationResult): Promise<void> {
    if (!channelId || !senderId?.trim()) return;

    await this.queueWrite((store) => {
      for (const sid of this.normalizeSenderVariants(senderId)) {
        const key = this.makeSenderKey(channelId, sid);
        const existing = store.bySender[key];
        if (existing) {
          store.bySender[key] = { ...existing, classification };
        }
      }
    });
  }

  async getClassification(channelId: string, senderId: string): Promise<ClassificationResult | undefined> {
    const store = await this.loadStore();
    for (const sid of this.normalizeSenderVariants(senderId)) {
      const hit = store.bySender[this.makeSenderKey(channelId, sid)];
      if (hit?.classification) return hit.classification;
    }
    return undefined;
  }
}
