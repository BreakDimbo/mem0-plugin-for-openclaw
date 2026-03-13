// ============================================================================
// Markdown Sync: periodically write high-value memories to MEMORY.md
// Supports per-agent workspace: hooks register agentId → workspaceDir,
// sync resolves memoryFilePath relative to each agent's workspace.
// ============================================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { MemUAdapter } from "./adapter.js";
import type { CoreMemoryRepository } from "./core-repository.js";
import type { CoreMemoryRecord, MemuPluginConfig, MemoryScope } from "./types.js";
import { audit } from "./security.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

const GENERATED_BLOCK_START = "<!-- memory-memu:start -->";
const GENERATED_BLOCK_END = "<!-- memory-memu:end -->";
const LEGACY_GENERATED_HEADER = "<!-- memory-memu:generated -->";
const GENERATED_SECTION_HEADINGS = new Set(["## Core Memory", "## Recent Long-Term Memory"]);

export class MarkdownSync {
  private adapter: MemUAdapter;
  private coreRepo: CoreMemoryRepository;
  private config: MemuPluginConfig;
  private logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _lastSyncAt = 0;
  private _syncCount = 0;
  private _totalWritten = 0;
  private pendingAgents = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Runtime registry: agentId → workspaceDir.
   * Populated by hooks calling registerAgent() when they receive ctx.
   */
  private agentWorkspaces = new Map<string, string>();

  constructor(adapter: MemUAdapter, coreRepo: CoreMemoryRepository, config: MemuPluginConfig, logger: Logger) {
    this.adapter = adapter;
    this.coreRepo = coreRepo;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Called by hooks/tools at runtime to register an agent's workspaceDir.
   * This enables sync to resolve memoryFilePath per-agent.
   */
  registerAgent(agentId: string, workspaceDir: string): void {
    const previous = this.agentWorkspaces.get(agentId);
    this.agentWorkspaces.set(agentId, workspaceDir);
    if (!previous) {
      this.logger.info(`markdown-sync: registered agent "${agentId}" -> ${workspaceDir}`);
    } else if (previous !== workspaceDir) {
      this.logger.info(`markdown-sync: updated agent "${agentId}" workspace -> ${workspaceDir}`);
    }
    this.scheduleSync(agentId);
  }

  /**
   * Resolve memoryFilePath for a given agent.
   *
   * - If memoryFilePath is absolute: use as-is (backward compatible, single file)
   * - If memoryFilePath is relative (e.g. "MEMORY.md"):
   *   resolve against the agent's registered workspaceDir
   */
  private resolveFilePath(agentId: string): string | null {
    const configured = this.config.sync.memoryFilePath;
    if (!configured) return null;

    if (isAbsolute(configured)) {
      // Absolute path — still support {agentId} template for backward compat
      return configured.replace(/\{agentId\}/g, agentId);
    }

    // Relative path — resolve against agent's workspaceDir
    const workspaceDir = this.agentWorkspaces.get(agentId);
    if (!workspaceDir) {
      return null;
    }
    return join(workspaceDir, configured);
  }

  private renderCoreSection(memories: CoreMemoryRecord[]): string {
    if (memories.length === 0) {
      return "## Core Memory\n\n- No synced core memories yet.\n";
    }
    const lines = memories.map((memory) => {
      const tag = `${memory.category ?? "general"}/${memory.key}`;
      return `- [${tag}] ${memory.value}`;
    });
    return ["## Core Memory", "", ...lines, ""].join("\n");
  }

  private renderRecallSection(items: Array<{ text: string; category?: string; score?: number }>): string {
    if (items.length === 0) return "";
    const lines = items.map((item) => {
      const parts = [`- ${item.text}`];
      const meta: string[] = [];
      if (item.category) meta.push(item.category);
      if (item.score !== undefined) meta.push(`score=${item.score.toFixed(2)}`);
      if (meta.length > 0) parts.push(` (${meta.join(", ")})`);
      return parts.join("");
    });
    return ["## Recent Long-Term Memory", "", ...lines, ""].join("\n");
  }

  private buildMarkdown(scope: MemoryScope, coreMemories: CoreMemoryRecord[], recallItems: Array<{ text: string; category?: string; score?: number }>): string {
    const header = [
      GENERATED_BLOCK_START,
      "<!-- memory-memu:generated -->",
      `<!-- scope:user=${scope.userId} agent=${scope.agentId} session=${scope.sessionKey} -->`,
      "",
      this.renderCoreSection(coreMemories).trimEnd(),
    ];
    const recallSection = this.renderRecallSection(recallItems);
    if (recallSection) {
      header.push("", recallSection.trimEnd());
    }
    header.push("", GENERATED_BLOCK_END);
    header.push("");
    return `${header.join("\n")}\n`;
  }

  private mergeWithExisting(existing: string, generatedBlock: string): string {
    const normalizedExisting = this.stripOrphanedMarkers(
      this.stripMarkedGeneratedBlocks(this.stripLegacyGeneratedBlocks(existing)),
    ).trim();

    if (!normalizedExisting) {
      return generatedBlock;
    }

    return `${generatedBlock.trimEnd()}\n\n${normalizedExisting.trimStart()}`;
  }

  private stripOrphanedMarkers(content: string): string {
    return content
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (trimmed === GENERATED_BLOCK_START || trimmed === GENERATED_BLOCK_END) {
          return false;
        }
        return true;
      })
      .join("\n");
  }

  private stripMarkedGeneratedBlocks(content: string): string {
    let next = content;
    while (true) {
      const start = next.indexOf(GENERATED_BLOCK_START);
      if (start < 0) break;
      const end = next.indexOf(GENERATED_BLOCK_END, start);
      if (end < 0) {
        next = `${next.slice(0, start)}\n${next.slice(start + GENERATED_BLOCK_START.length)}`;
        continue;
      }
      next = `${next.slice(0, start)}\n${next.slice(end + GENERATED_BLOCK_END.length)}`;
    }
    return next;
  }

  private stripLegacyGeneratedBlocks(content: string): string {
    const lines = content.split("\n");
    const out: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (line.trim() !== LEGACY_GENERATED_HEADER) {
        out.push(line);
        i++;
        continue;
      }

      i++;
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const trimmed = current.trim();
        if (trimmed.startsWith("<!-- scope:")) {
          i++;
          continue;
        }
        if (!trimmed) {
          i++;
          continue;
        }
        if (trimmed.startsWith("## ") && !GENERATED_SECTION_HEADINGS.has(trimmed)) {
          break;
        }
        i++;
      }
    }

    return out.join("\n").replace(/^\s+/, "");
  }

  private async syncOnce(): Promise<void> {
    const configured = this.config.sync.memoryFilePath;
    if (!configured) {
      this.logger.warn("markdown-sync: no memoryFilePath configured, skipping");
      return;
    }

    try {
      if (isAbsolute(configured) && !configured.includes("{agentId}")) {
        // Single static absolute path — sync once with default scope
        await this.syncForAgent(this.config.scope.agentId);
      } else {
        // Per-agent sync: iterate all registered agents
        if (this.agentWorkspaces.size === 0) {
          // No agents registered yet, nothing to sync
          return;
        }
        for (const agentId of this.agentWorkspaces.keys()) {
          await this.syncForAgent(agentId);
        }
      }
    } catch (err) {
      this.logger.warn(`markdown-sync: error: ${String(err)}`);
    }
  }

  scheduleSync(agentId?: string): void {
    if (!this.config.sync.flushToMarkdown) return;
    if (agentId) {
      this.pendingAgents.add(agentId);
    } else {
      for (const knownAgentId of this.agentWorkspaces.keys()) {
        this.pendingAgents.add(knownAgentId);
      }
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      const pending = Array.from(this.pendingAgents);
      this.pendingAgents.clear();
      this.debounceTimer = null;
      void this.flushPendingAgents(pending);
    }, 1_000);
  }

  async forceSync(agentId?: string): Promise<{ syncedAgents: string[] }> {
    const agents = agentId ? [agentId] : Array.from(this.agentWorkspaces.keys());
    await this.flushPendingAgents(agents);
    return { syncedAgents: agents };
  }

  private async flushPendingAgents(agentIds: string[]): Promise<void> {
    for (const agentId of agentIds) {
      await this.syncForAgent(agentId);
    }
  }

  private async syncForAgent(agentId: string): Promise<void> {
    const filePath = this.resolveFilePath(agentId);
    if (!filePath) {
      this.logger.warn(`markdown-sync: skipped agent "${agentId}" because workspace is unknown`);
      return;
    }

    try {
      const scope = this.adapter.resolveRuntimeScope({ agentId });
      const coreMemories = await this.coreRepo.list(scope, {
        limit: this.config.core.topK,
      });

      const recallItems =
        this.config.recall.enabled && coreMemories.length > 0
          ? await this.adapter.recall("long-term memory summary", scope, {
              maxItems: Math.min(8, this.config.recall.topK),
              maxContextChars: this.config.recall.maxContextChars,
            })
          : [];

      const markdown = this.buildMarkdown(scope, coreMemories, recallItems);
      let existing = "";
      try {
        existing = await readFile(filePath, "utf-8");
      } catch {
        await mkdir(dirname(filePath), { recursive: true });
      }
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, this.mergeWithExisting(existing, markdown), "utf-8");

      this._lastSyncAt = Date.now();
      this._syncCount++;
      this._totalWritten += coreMemories.length + recallItems.length;

      audit("store", scope.userId, agentId, `markdown-sync: wrote ${coreMemories.length} core + ${recallItems.length} recall items to ${filePath}`);

      this.logger.info(
        `markdown-sync: [${agentId}] wrote core=${coreMemories.length} recall=${recallItems.length} -> ${filePath}`,
      );
    } catch (err) {
      this.logger.warn(`markdown-sync: [${agentId}] error: ${String(err)}`);
    }
  }

  start(): void {
    if (!this.config.sync.flushToMarkdown) return;
    if (this.timer) return;

    const intervalMs = this.config.sync.flushIntervalSec * 1000;

    this.timer = setInterval(() => {
      this.syncOnce().catch((err) => {
        this.logger.warn(`markdown-sync: tick error: ${String(err)}`);
      });
    }, intervalMs);

    this.logger.info(`markdown-sync: started (interval: ${this.config.sync.flushIntervalSec}s)`);
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info(`markdown-sync: stopped (syncs: ${this._syncCount}, total written: ${this._totalWritten})`);
    }
  }

  get lastSyncAt(): number {
    return this._lastSyncAt;
  }

  get syncCount(): number {
    return this._syncCount;
  }

  get totalWritten(): number {
    return this._totalWritten;
  }
}
