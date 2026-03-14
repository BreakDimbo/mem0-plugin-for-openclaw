import type { MemUAdapter } from "../../adapter.js";
import type { MemoryScope, MemuMemoryRecord } from "../../types.js";
import type { FreeTextBackend, FreeTextBackendStatus, FreeTextForgetOptions, FreeTextSearchOptions, FreeTextStoreOptions } from "./base.js";

export class MemUFreeTextBackend implements FreeTextBackend {
  readonly provider = "memu";

  constructor(
    private readonly adapter: MemUAdapter,
    private readonly healthCheckFn: () => Promise<boolean>,
  ) {}

  async healthCheck(): Promise<FreeTextBackendStatus> {
    const healthy = await this.healthCheckFn();
    return {
      provider: this.provider,
      healthy,
      detail: healthy ? "memU server reachable" : "memU server unavailable",
    };
  }

  async store(text: string, scope: MemoryScope, options?: FreeTextStoreOptions): Promise<boolean> {
    const metadata = {
      ...(options?.metadata ?? {}),
      content_kind: "free-text",
    };
    return this.adapter.memorize(text, scope, metadata);
  }

  async search(query: string, scope: MemoryScope, options?: FreeTextSearchOptions): Promise<MemuMemoryRecord[]> {
    return this.adapter.recall(query, scope, options);
  }

  async list(scope: MemoryScope, options?: { limit?: number; includeSessionScope?: boolean }): Promise<MemuMemoryRecord[]> {
    const categories = await this.adapter.listCategories(scope);
    return categories
      .slice(0, options?.limit ?? categories.length)
      .map((category) => ({
        text: category.description ?? category.name,
        category: category.name,
        source: "memu_category" as const,
        scope,
      }));
  }

  async forget(scope: MemoryScope, options?: FreeTextForgetOptions) {
    if (options?.memoryId) return null;
    return this.adapter.forget(scope);
  }
}
