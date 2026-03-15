// ============================================================================
// memory-mem0: Plugin Entry Point
// Phase 2/3: full scope config, metrics, persistence, audit, graceful shutdown
// ============================================================================

import type { OpenClawPluginDefinition, OpenClawPluginApi } from "openclaw/plugin-sdk";

import { buildDynamicScope } from "./types.js";
import { loadConfig } from "./types.js";
import type { MemuMemoryRecord } from "./types.js";
import { LRUCache } from "./cache.js";
import { InboundMessageCache } from "./inbound-cache.js";
import { OutboxWorker } from "./outbox.js";
import { MarkdownSync } from "./sync.js";
import { Metrics } from "./metrics.js";
import { CoreMemoryRepository } from "./core-repository.js";
import { CoreProposalQueue } from "./core-proposals.js";
import { CandidateQueue } from "./candidate-queue.js";
import { createPrimaryFreeTextBackend } from "./backends/free-text/factory.js";
import { resolveWorkspaceDir } from "./workspace-facts.js";
import { extractCoreProposal } from "./core-proposals.js";
import { buildFreeTextMetadata } from "./metadata.js";
import { judgeCandidates } from "./core-admission.js";

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
  id: "memory-mem0",
  name: "memory-mem0",
  description: "Enhanced memory with memU for long-term structured recall, scoped retrieval, and async capture",

  register(api: OpenClawPluginApi) {
    // -- Config --
    const config = loadConfig(api.pluginConfig as Record<string, unknown> | undefined);

    // -- Core modules --
    const scopeResolver = {
      resolveRuntimeScope: (ctx?: { agentId?: string; sessionKey?: string; sessionId?: string; workspaceDir?: string }) =>
        buildDynamicScope(config.scope, ctx),
    };
    const coreRepo = new CoreMemoryRepository(config.core.persistPath, api.logger, config.core.maxItemChars);
    const cache = new LRUCache<MemuMemoryRecord[]>(config.recall.cacheMaxSize, config.recall.cacheTtlMs);
    const inbound = new InboundMessageCache(`${config.outbox.persistPath}/inbound-message-cache.json`);
    const metrics = new Metrics();
    const proposalQueue = new CoreProposalQueue(config.outbox.persistPath, config.core.proposalQueueMax, api.logger);

    const primaryFreeTextBackend = createPrimaryFreeTextBackend(config, { logger: api.logger });

    const outbox = new OutboxWorker(primaryFreeTextBackend, api.logger, {
      concurrency: config.outbox.concurrency,
      batchSize: config.outbox.batchSize,
      maxRetries: config.outbox.maxRetries,
      persistPath: config.outbox.persistPath,
      flushIntervalMs: config.outbox.flushIntervalMs,
    });

    const sync = new MarkdownSync(primaryFreeTextBackend, scopeResolver, coreRepo, config, api.logger);

    // -- CandidateQueue: per-message capture with configurable batch timer --
    let lastConsolidateAt = 0;
    const candidateQueue = new CandidateQueue(
      async (batch) => {
        // Items that regex didn't catch — collected for batch LLM gate
        const llmCandidates: Array<{ index: number; item: (typeof batch)[0] }> = [];

        for (let i = 0; i < batch.length; i++) {
          const item = batch[i];

          // Route to outbox for free-text memorization (always)
          outbox.enqueue(
            item.text,
            item.scope,
            buildFreeTextMetadata(item.text, item.scope, { captureKind: "auto" }),
          );

          // Attempt core extraction via regex (high-confidence patterns)
          let regexMatched = false;
          if (config.core.enabled && config.core.autoExtractProposals) {
            const draft = extractCoreProposal(item.text, item.scope);
            if (draft) {
              regexMatched = true;
              if (config.core.humanReviewRequired) {
                proposalQueue.enqueue(draft);
              } else {
                await coreRepo.upsert(item.scope, {
                  key: draft.key,
                  value: draft.value,
                  source: "capture-queue",
                  metadata: { reason: draft.reason, proposal_text: draft.text },
                });
              }
            }
          }

          // Collect for LLM gate if regex missed
          if (!regexMatched && config.core.llmGate.enabled) {
            llmCandidates.push({ index: i, item });
          }
        }

        // Batch LLM gate for regex-missed candidates
        if (llmCandidates.length > 0) {
          const texts = llmCandidates.map((c) => c.item.text);
          const results = await judgeCandidates(texts, config.core.llmGate, api.logger);

          for (const result of results) {
            if (result.verdict !== "core") continue;
            if (!result.key || !result.value) continue;

            // Map 1-based LLM index back to batch item
            const candidate = llmCandidates[result.index - 1];
            if (!candidate) continue;

            if (config.core.humanReviewRequired) {
              proposalQueue.enqueue({
                category: result.key.split(".")[0] || "general",
                text: candidate.item.text,
                key: result.key,
                value: result.value,
                reason: result.reason || "llm-gate",
                scope: candidate.item.scope,
              });
            } else {
              await coreRepo.upsert(candidate.item.scope, {
                key: result.key,
                value: result.value,
                source: "capture-llm-gate",
                metadata: { reason: result.reason, original_text: candidate.item.text },
              });
            }
          }
        }

        if (batch.length > 0) {
          sync.scheduleSync(batch[0].scope.agentId);
        }

        // Consolidate core memory after batch processing (throttled)
        if (config.core.enabled && config.core.consolidation.enabled && batch.length > 0) {
          const now = Date.now();
          if (now - lastConsolidateAt >= config.core.consolidation.intervalMs) {
            lastConsolidateAt = now;
            const scope = batch[0].scope;
            coreRepo.consolidate(scope, {
              similarityThreshold: config.core.consolidation.similarityThreshold,
            }).catch((err) => {
              api.logger.warn(`memory-mem0: consolidation failed: ${String(err)}`);
            });
          }
        }
      },
      api.logger,
      {
        intervalMs: config.capture.candidateQueue.intervalMs,
        maxBatchSize: config.capture.candidateQueue.maxBatchSize,
        persistPath: config.outbox.persistPath,
      },
    );

    // Pre-register fallback workspace for the configured/default agent so the
    // periodic sync loop can resolve MEMORY.md before any hook fires.
    // Hooks still override this with runtime ctx.workspaceDir when available.
    const bootstrapAgentId = config.scope.agentId || "main";
    sync.registerAgent(bootstrapAgentId, resolveWorkspaceDir(bootstrapAgentId));

    api.logger.info(
      `memory-mem0: registered (core=local, freeText=${config.backend.freeText.provider}, userId: ${config.scope.userId}, agentId: ${config.scope.agentId}, recall: ${config.recall.enabled}, capture: ${config.capture.enabled})`,
    );

    // ========================================================================
    // Hooks
    // ========================================================================

    if (config.recall.enabled || config.core.enabled) {
      api.on("before_prompt_build", createRecallHook(primaryFreeTextBackend, scopeResolver, coreRepo, cache, inbound, config, api.logger, metrics, sync), {
        priority: HOOK_PRIORITY.recall,
      });
    }

    if (config.capture.enabled) {
      api.on("agent_end", createCaptureHook(outbox, coreRepo, proposalQueue, cache, config, api.logger, metrics, sync), {
        priority: HOOK_PRIORITY.capture,
      });
    }

    api.on("message_received", createMessageReceivedHook(inbound, candidateQueue, coreRepo, config, api.logger), {
      priority: HOOK_PRIORITY.messageReceived,
    });

    // ========================================================================
    // Tools (factory pattern to capture runtime context)
    // ========================================================================

    api.registerTool((ctx: any) => createRecallTool(primaryFreeTextBackend, cache, config, metrics, ctx));
    api.registerTool((ctx: any) => createStoreTool(outbox, config, ctx));
    api.registerTool((ctx: any) => createForgetTool(primaryFreeTextBackend, config, ctx));
    api.registerTool((ctx: any) => createStatsTool(primaryFreeTextBackend, cache, outbox, metrics, ctx));
    api.registerTool((ctx: any) => createCoreListTool(coreRepo, config, ctx));
    api.registerTool((ctx: any) => createCoreUpsertTool(coreRepo, config, ctx));
    api.registerTool((ctx: any) => createCoreDeleteTool(coreRepo, config, ctx));
    api.registerTool((ctx: any) => createCoreTouchTool(coreRepo, config, ctx));
    api.registerTool((ctx: any) => createCoreProposalTool(proposalQueue, coreRepo, config, ctx));

    // ========================================================================
    // Commands
    // ========================================================================

    api.registerCommand(
      createMemuCommand(
        primaryFreeTextBackend,
        coreRepo,
        proposalQueue,
        cache,
        outbox,
        metrics,
        sync,
        config,
        api.runtime,
      ),
    );

    // ========================================================================
    // Service lifecycle
    // ========================================================================

    api.registerService({
      id: "memory-mem0",
      start: async (_ctx) => {
        api.logger.info("memory-mem0: using local core store and mem0 free-text backend");

        // Start outbox worker (loads persisted queue from disk)
        if (config.outbox.enabled) {
          await outbox.start();
        }
        await proposalQueue.start();

        // Start candidate queue (per-message capture with batch timer)
        if (config.capture.enabled && config.capture.candidateQueue.enabled) {
          await candidateQueue.start();
        }

        // Start markdown sync
        sync.start();

        api.logger.info("memory-mem0: service started");
      },
      stop: async (_ctx) => {
        // Graceful shutdown: drain candidate queue and outbox with timeout
        if (config.capture.enabled && config.capture.candidateQueue.enabled) {
          await candidateQueue.drain(config.outbox.drainTimeoutMs);
          candidateQueue.stop();
        }
        if (config.outbox.enabled) {
          await outbox.drain(config.outbox.drainTimeoutMs);
          outbox.stop();
        }
        await proposalQueue.stop();

        sync.stop();
        cache.clear();

        api.logger.info("memory-mem0: service stopped");
      },
    });
  },
};

export default memoryMemuPlugin;
