import type { MemoryScope, MemuMemoryRecord } from "../../types.js";

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type FreeTextSearchOptions = {
  maxItems?: number;
  maxContextChars?: number;
  category?: string;
  includeSessionScope?: boolean;
  quality?: "durable" | "transient";
  memoryKinds?: string[];
  captureKind?: "explicit" | "auto";
  /** Include expired items (default: false — expired items are filtered out) */
  includeExpired?: boolean;
};

export type FreeTextStoreOptions = {
  sessionScoped?: boolean;
  metadata?: Record<string, unknown>;
  memory_kind?: string;
};

export type FreeTextForgetOptions = {
  memoryId?: string;
  query?: string;
};

export type FreeTextBackendStatus = {
  provider: string;
  mode?: string;
  healthy: boolean;
  detail?: string;
};

export interface FreeTextBackend {
  readonly provider: string;
  healthCheck(): Promise<FreeTextBackendStatus>;
  store(messages: ConversationMessage[], scope: MemoryScope, options?: FreeTextStoreOptions): Promise<boolean>;
  search(query: string, scope: MemoryScope, options?: FreeTextSearchOptions): Promise<MemuMemoryRecord[]>;
  list(scope: MemoryScope, options?: { limit?: number; includeSessionScope?: boolean }): Promise<MemuMemoryRecord[]>;
  forget(scope: MemoryScope, options?: FreeTextForgetOptions): Promise<{
    purged_categories: number;
    purged_items: number;
    purged_resources: number;
  } | null>;
}
