// ============================================================================
// memory-memu: Plugin Entry Point
// Phase 2/3: full scope config, metrics, persistence, audit, graceful shutdown
// ============================================================================

import type { OpenClawPluginDefinition, OpenClawPluginApi } from "openclaw/plugin-sdk";

import { loadConfig } from "./types.js";
import type { MemuMemoryRecord } from "./types.js";
import { MemUClient } from "./client.js";
import { MemUAdapter } from "./adapter.js";
import { LRUCache } from "./cache.js";
import { OutboxWorker } from "./outbox.js";
import { MarkdownSync } from "./sync.js";
import { Metrics } from "./metrics.js";

import { createRecallHook } from "./hooks/recall.js";
import { createCaptureHook } from "./hooks/capture.js";

import { createRecallTool } from "./tools/recall.js";
import { createStoreTool } from "./tools/store.js";
import { createForgetTool } from "./tools/forget.js";
import { createStatsTool } from "./tools/stats.js";

import { createMemuCommand } from "./cli.js";

const memoryMemuPlugin: OpenClawPluginDefinition = {
  id: "memory-memu",
  name: "memU Enhanced Memory",
  description: "Enhanced memory with memU for long-term structured recall, scoped retrieval, and async capture",

  register(api: OpenClawPluginApi) {
    // -- Config --
    const config = loadConfig(api.pluginConfig as Record<string, unknown> | undefined);

    // -- Core modules --
    const client = new MemUClient(
      config.memu.baseUrl,
      config.memu.timeoutMs,
      config.memu.cbResetMs,
      config.memu.healthCheckPath,
      api.logger,
    );
    const adapter = new MemUAdapter(client, config.scope, api.logger, config.recall.method);
    const cache = new LRUCache<MemuMemoryRecord[]>(config.recall.cacheMaxSize, config.recall.cacheTtlMs);
    const metrics = new Metrics();

    const outbox = new OutboxWorker(adapter, api.logger, {
      concurrency: config.outbox.concurrency,
      batchSize: config.outbox.batchSize,
      maxRetries: config.outbox.maxRetries,
      persistPath: config.outbox.persistPath,
      flushIntervalMs: config.outbox.flushIntervalMs,
    });

    const sync = new MarkdownSync(adapter, config, api.logger);

    api.logger.info(
      `memory-memu: registered (baseUrl: ${config.memu.baseUrl}, userId: ${config.scope.userId}, agentId: ${config.scope.agentId}, recall: ${config.recall.enabled}, capture: ${config.capture.enabled})`,
    );

    // ========================================================================
    // Hooks
    // ========================================================================

    if (config.recall.enabled) {
      api.on("before_agent_start", createRecallHook(adapter, cache, config, api.logger, metrics, sync));
    }

    if (config.capture.enabled) {
      api.on("agent_end", createCaptureHook(outbox, cache, config, api.logger, metrics, sync));
    }

    // ========================================================================
    // Tools (factory pattern to capture runtime context)
    // ========================================================================

    api.registerTool((ctx: any) => createRecallTool(adapter, cache, config, metrics, ctx));
    api.registerTool((ctx: any) => createStoreTool(outbox, config, ctx));
    api.registerTool((ctx: any) => createForgetTool(adapter, config, ctx));
    api.registerTool((ctx: any) => createStatsTool(client, cache, outbox, metrics, ctx));

    // ========================================================================
    // Commands
    // ========================================================================

    api.registerCommand(createMemuCommand(client, adapter, cache, outbox, metrics, sync, config, api.runtime));

    // ========================================================================
    // Service lifecycle
    // ========================================================================

    api.registerService({
      id: "memory-memu",
      start: async () => {
        const healthy = await client.healthCheck();
        if (healthy) {
          api.logger.info(`memory-memu: Connected to ${config.memu.baseUrl}`);
        } else {
          api.logger.warn(`memory-memu: Server at ${config.memu.baseUrl} unreachable — memories unavailable until it comes online`);
        }

        // Start outbox worker (loads persisted queue from disk)
        if (config.outbox.enabled) {
          await outbox.start();
        }

        // Start markdown sync
        sync.start();

        api.logger.info("memory-memu: service started");
      },
      stop: async () => {
        // Graceful shutdown: drain outbox with timeout
        if (config.outbox.enabled) {
          await outbox.drain(config.outbox.drainTimeoutMs);
          outbox.stop();
        }

        sync.stop();
        cache.clear();

        api.logger.info("memory-memu: service stopped");
      },
    });
  },
};

export default memoryMemuPlugin;
