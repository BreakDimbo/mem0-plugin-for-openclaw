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
import { InboundMessageCache } from "./inbound-cache.js";
import { OutboxWorker } from "./outbox.js";
import { MarkdownSync } from "./sync.js";
import { Metrics } from "./metrics.js";
import { CoreMemoryRepository } from "./core-repository.js";
import { CoreProposalQueue } from "./core-proposals.js";

import { createRecallHook } from "./hooks/recall.js";
import { createCaptureHook } from "./hooks/capture.js";
import { createMessageReceivedHook } from "./hooks/message-received.js";

import { createRecallTool } from "./tools/recall.js";
import { createStoreTool } from "./tools/store.js";
import { createForgetTool } from "./tools/forget.js";
import { createStatsTool } from "./tools/stats.js";
import { createCoreListTool } from "./tools/core-list.js";
import { createCoreUpsertTool } from "./tools/core-upsert.js";
import { createCoreDeleteTool } from "./tools/core-delete.js";
import { createCoreTouchTool } from "./tools/core-touch.js";
import { createCoreProposalTool } from "./tools/core-proposals.js";

import { createMemuCommand } from "./cli.js";

const HOOK_PRIORITY = {
  recall: 100,
  capture: 100,
  messageReceived: 100,
} as const;

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
    const adapter = new MemUAdapter(client, config.scope, api.logger, config.recall.method, config.recall.hybrid);
    const coreRepo = new CoreMemoryRepository(client, api.logger, config.core.maxItemChars);
    const cache = new LRUCache<MemuMemoryRecord[]>(config.recall.cacheMaxSize, config.recall.cacheTtlMs);
    const inbound = new InboundMessageCache(`${config.outbox.persistPath}/inbound-message-cache.json`);
    const metrics = new Metrics();
    const proposalQueue = new CoreProposalQueue(config.outbox.persistPath, config.core.proposalQueueMax, api.logger);

    const outbox = new OutboxWorker(adapter, api.logger, {
      concurrency: config.outbox.concurrency,
      batchSize: config.outbox.batchSize,
      maxRetries: config.outbox.maxRetries,
      persistPath: config.outbox.persistPath,
      flushIntervalMs: config.outbox.flushIntervalMs,
    });

    const sync = new MarkdownSync(adapter, coreRepo, config, api.logger);

    api.logger.info(
      `memory-memu: registered (baseUrl: ${config.memu.baseUrl}, userId: ${config.scope.userId}, agentId: ${config.scope.agentId}, recall: ${config.recall.enabled}, capture: ${config.capture.enabled})`,
    );

    // ========================================================================
    // Hooks
    // ========================================================================

    if (config.recall.enabled || config.core.enabled) {
      api.on("before_prompt_build", createRecallHook(adapter, coreRepo, cache, inbound, config, api.logger, metrics, sync), {
        priority: HOOK_PRIORITY.recall,
      });
    }

    if (config.capture.enabled) {
      api.on("agent_end", createCaptureHook(outbox, coreRepo, proposalQueue, cache, config, api.logger, metrics, sync), {
        priority: HOOK_PRIORITY.capture,
      });
    }

    api.on("message_received", createMessageReceivedHook(inbound, api.logger), {
      priority: HOOK_PRIORITY.messageReceived,
    });

    // ========================================================================
    // Tools (factory pattern to capture runtime context)
    // ========================================================================

    api.registerTool((ctx: any) => createRecallTool(adapter, cache, config, metrics, ctx));
    api.registerTool((ctx: any) => createStoreTool(outbox, config, ctx));
    api.registerTool((ctx: any) => createForgetTool(adapter, config, ctx));
    api.registerTool((ctx: any) => createStatsTool(client, cache, outbox, metrics, ctx));
    api.registerTool((ctx: any) => createCoreListTool(coreRepo, config, ctx));
    api.registerTool((ctx: any) => createCoreUpsertTool(coreRepo, config, ctx));
    api.registerTool((ctx: any) => createCoreDeleteTool(coreRepo, config, ctx));
    api.registerTool((ctx: any) => createCoreTouchTool(coreRepo, config, ctx));
    api.registerTool((ctx: any) => createCoreProposalTool(proposalQueue, coreRepo, config, ctx));

    // ========================================================================
    // Commands
    // ========================================================================

    api.registerCommand(createMemuCommand(client, adapter, coreRepo, proposalQueue, cache, outbox, metrics, sync, config, api.runtime));

    // ========================================================================
    // Service lifecycle
    // ========================================================================

    api.registerService({
      id: "memory-memu",
      start: async (_ctx) => {
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
        await proposalQueue.start();

        // Start markdown sync
        sync.start();

        api.logger.info("memory-memu: service started");
      },
      stop: async (_ctx) => {
        // Graceful shutdown: drain outbox with timeout
        if (config.outbox.enabled) {
          await outbox.drain(config.outbox.drainTimeoutMs);
          outbox.stop();
        }
        await proposalQueue.stop();

        sync.stop();
        cache.clear();

        api.logger.info("memory-memu: service stopped");
      },
    });
  },
};

export default memoryMemuPlugin;
