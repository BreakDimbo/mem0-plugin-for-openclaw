// ============================================================================
// Markdown Sync: periodically write high-value memories to MEMORY.md
// Supports per-agent workspace: hooks register agentId → workspaceDir,
// sync resolves memoryFilePath relative to each agent's workspace.
// ============================================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { MemUAdapter } from "./adapter.js";
import type { MemuPluginConfig } from "./types.js";
import { audit } from "./security.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

export class MarkdownSync {
  private adapter: MemUAdapter;
  private config: MemuPluginConfig;
  private logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _lastSyncAt = 0;
  private _syncCount = 0;
  private _totalWritten = 0;

  /**
   * Runtime registry: agentId → workspaceDir.
   * Populated by hooks calling registerAgent() when they receive ctx.
   */
  private agentWorkspaces = new Map<string, string>();

  constructor(adapter: MemUAdapter, config: MemuPluginConfig, logger: Logger) {
    this.adapter = adapter;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Called by hooks/tools at runtime to register an agent's workspaceDir.
   * This enables sync to resolve memoryFilePath per-agent.
   */
  registerAgent(agentId: string, workspaceDir: string): void {
    if (!this.agentWorkspaces.has(agentId)) {
      this.agentWorkspaces.set(agentId, workspaceDir);
      this.logger.info(`markdown-sync: registered agent "${agentId}" → ${workspaceDir}`);
    }
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

  private async syncForAgent(agentId: string): Promise<void> {
    const filePath = this.resolveFilePath(agentId);
    if (!filePath) {
      return;
    }

    try {
      // Fetch categories scoped to this agent
      const agentCategories = await this.adapter.listCategories({ agentId });
      if (agentCategories.length === 0) {
        return;
      }

      // Recall high-level memories scoped to this agent
      const query = agentCategories.map((c) => c.name).join(", ");
      const scopeOverride = { agentId };
      const memories = await this.adapter.recall(query, scopeOverride, { maxItems: 20 });

      if (memories.length === 0) {
        return;
      }

      // Read existing file
      let existing = "";
      try {
        existing = await readFile(filePath, "utf-8");
      } catch {
        // File doesn't exist yet — ensure directory exists
        await mkdir(dirname(filePath), { recursive: true });
      }

      // Deduplicate: skip memories whose core text already appears in the file
      const newMemories = memories.filter((m) => {
        const snippet = m.text.slice(0, 80);
        return !existing.includes(snippet);
      });

      if (newMemories.length === 0) {
        return;
      }

      // Build section to append
      const timestamp = new Date().toISOString().slice(0, 10);
      const section = [
        "",
        `## memU Synced Memories (${timestamp})`,
        "",
        ...newMemories.map((m) => {
          const cat = m.category ? ` _(${m.category})_` : "";
          const score = m.score !== undefined ? ` [score: ${m.score.toFixed(2)}]` : "";
          return `- ${m.text}${cat}${score}`;
        }),
        "",
      ].join("\n");

      const updated = existing.trimEnd() + "\n" + section;
      await writeFile(filePath, updated, "utf-8");

      this._lastSyncAt = Date.now();
      this._syncCount++;
      this._totalWritten += newMemories.length;

      const scope = this.adapter.getDefaultScope();
      audit("store", scope.userId, agentId, `markdown-sync: wrote ${newMemories.length} memories to ${filePath}`);

      this.logger.info(`markdown-sync: [${agentId}] appended ${newMemories.length} memories to ${filePath}`);
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
