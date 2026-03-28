// ============================================================================
// memory-mem0: Plugin Entry Point
// Phase 2/3: full scope config, metrics, persistence, audit, graceful shutdown
// ============================================================================

import { buildDynamicScope } from "./types.js";
import { loadConfig } from "./types.js";
import type { MemuMemoryRecord, ClassificationResult } from "./types.js";
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
import { judgeCandidates, buildCandidateContextText, resolveCaptureRouting } from "./core-admission.js";
import { isKnowledgeDump } from "./security.js";
import { UnifiedIntentClassifier } from "./classifier.js";

import { CaptureDedupStore } from "./capture-dedup-store.js";
import { createRecallHook } from "./hooks/recall.js";
import { createCaptureHook } from "./hooks/capture.js";
import { createMessageReceivedHook } from "./hooks/message-received.js";
import { createSmartRouterHook } from "./hooks/smart-router.js";

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
import { ConsolidationRunner } from "./consolidation/runner.js";
import { ConsolidationScheduler } from "./consolidation/scheduler.js";

type PluginLogger = { info(msg: string): void; warn(msg: string): void };

type OpenClawPluginApi = {
  pluginConfig?: unknown;
  logger: PluginLogger;
  runtime?: unknown;
  on(event: string, handler: unknown, options?: { priority?: number }): void;
  registerTool(factory: unknown): void;
  registerCommand(command: unknown): void;
  registerService(service: { id: string; start(ctx: unknown): Promise<void>; stop(ctx: unknown): Promise<void> }): void;
};

type OpenClawPluginDefinition = {
  id: string;
  name: string;
  description: string;
  register(api: OpenClawPluginApi): void;
};

const HOOK_PRIORITY = {
  smartRouter: 200,
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

    // -- Unified Intent Classifier --
    const classifierCache = new LRUCache<ClassificationResult>(
      config.classifier.cacheMaxSize ?? 200,
      config.classifier.cacheTtlMs ?? 300_000,
    );
    const classifierMetrics = {
      classifierCalls: 0,
      classifierHits: 0,
      classifierErrors: 0,
    };
    const classifier = config.classifier.enabled !== false
      ? new UnifiedIntentClassifier(config.classifier, classifierCache, classifierMetrics, api.logger)
      : undefined;

    const outbox = new OutboxWorker(primaryFreeTextBackend, api.logger, {
      concurrency: config.outbox.concurrency,
      batchSize: config.outbox.batchSize,
      maxRetries: config.outbox.maxRetries,
      persistPath: config.outbox.persistPath,
      flushIntervalMs: config.outbox.flushIntervalMs,
    });

    const captureDedupStore = new CaptureDedupStore(config.outbox.persistPath);
    const sync = new MarkdownSync(primaryFreeTextBackend, scopeResolver, coreRepo, config, api.logger);

    const consolidationRunner = new ConsolidationRunner(coreRepo, config.core.consolidation, api.logger, primaryFreeTextBackend);
    const consolidationScheduler = new ConsolidationScheduler(
      consolidationRunner,
      config.core.consolidation,
      { userId: config.scope.userId, agentId: config.scope.agentId, sessionKey: "consolidation" },
      api.logger,
    );

    // -- CandidateQueue: per-message capture with configurable batch timer --
    let lastConsolidateAt = 0;
    const candidateQueue = new CandidateQueue(
      async (batch) => {
        // Items deferred to LLM gate — only written to free-text if verdict is core/free_text
        const llmCandidates: Array<{ index: number; item: (typeof batch)[0] }> = [];

        api.logger.info(`capture-processor: processing batch of ${batch.length} candidates`);

        for (let i = 0; i < batch.length; i++) {
          const item = batch[i];

          // Get text from messages for core extraction (use last user message)
          const lastUserMsg = [...item.messages].reverse().find(m => m.role === "user");
          const itemText = lastUserMsg?.content ?? "";

          api.logger.info(`capture-processor: [${i}] text="${itemText.slice(0, 80)}${itemText.length > 80 ? '...' : ''}"`);

          const itemClassification = item.metadata?.classification as ClassificationResult | undefined;
          const { skipCapture, skipLlmGate } = resolveCaptureRouting(itemClassification);

          // Skip greeting / explicit-skip entirely — not worth storing anywhere
          if (skipCapture) {
            api.logger.info(`capture-processor: [${i}] SKIPPED (classification=${itemClassification?.queryType}, hint=${itemClassification?.captureHint})`);
            continue;
          }

          // Attempt core extraction via regex (high-confidence patterns)
          let regexMatched = false;
          if (config.core.enabled && config.core.autoExtractProposals && itemText) {
            const draft = extractCoreProposal(itemText, item.scope);
            if (draft) {
              regexMatched = true;
              api.logger.info(`capture-processor: [${i}] regex MATCHED → key=${draft.key}, value=${draft.value.slice(0, 50)}`);
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
            } else {
              api.logger.info(`capture-processor: [${i}] regex NO MATCH`);
            }
          } else {
            api.logger.info(`capture-processor: [${i}] regex SKIPPED (enabled=${config.core.enabled}, autoExtract=${config.core.autoExtractProposals}, hasText=${!!itemText})`);
          }

          // Routing decision for free-text (outbox):
          // - regex matched: write now (high-confidence regex hit → core already stored above)
          // - LLM gate disabled: write now (permissive fallback)
          // - skipLlmGate ("light" hint): write now (free-text only, skip core LLM judgment)
          // - otherwise: defer to LLM gate for core/free_text/discard verdict
          if (regexMatched || !config.core.llmGate.enabled || skipLlmGate || !itemText) {
            if (itemText) {
              outbox.enqueue(
                item.messages,
                item.scope,
                buildFreeTextMetadata(itemText, item.scope, { captureKind: "auto" }),
              );
              const reason = regexMatched ? "regex matched" : !config.core.llmGate.enabled ? "llmGate disabled" : skipLlmGate ? `skipLlmGate (${itemClassification?.queryType})` : "no text";
              api.logger.info(`capture-processor: [${i}] → outbox directly (${reason})`);
            }
          } else {
            // Defer to LLM gate — only write to outbox if verdict is core or free_text
            llmCandidates.push({ index: i, item });
            api.logger.info(`capture-processor: [${i}] → LLM gate (classification=${itemClassification?.queryType || 'none'}, hint=${itemClassification?.captureHint || 'none'})`);
          }
        }

        // Batch LLM gate for deferred candidates
        if (llmCandidates.length > 0) {
          api.logger.info(`capture-processor: LLM gate batch processing ${llmCandidates.length} candidates`);
          const texts = llmCandidates.map((c) =>
            buildCandidateContextText(c.item.messages),
          );
          const results = await judgeCandidates(texts, config.core.llmGate, api.logger);

          api.logger.info(`capture-processor: LLM gate returned ${results.length} results`);

          // Track which positions (0-based in llmCandidates) are approved for free-text
          // Items not mentioned by LLM are implicitly discarded (system prompt: "discard 类型可以省略不输出")
          const approvedPositions = new Set<number>();

          for (const result of results) {
            api.logger.info(`capture-processor: LLM verdict [index=${result.index}] verdict=${result.verdict}${result.key ? ` key=${result.key}` : ''}${result.reason ? ` reason="${result.reason}"` : ''}`);

            const candidate = llmCandidates[result.index - 1];
            if (!candidate) {
              api.logger.info(`capture-processor: LLM verdict rejected (invalid index ${result.index})`);
              continue;
            }

            if (result.verdict === "discard") {
              api.logger.info(`capture-processor: LLM discard [${result.index}] → skipping outbox`);
              continue;
            }

            // free_text or core: approve for free-text write
            approvedPositions.add(result.index - 1);

            if (result.verdict === "core") {
              if (!result.key || !result.value) {
                api.logger.info(`capture-processor: LLM verdict rejected (missing key or value)`);
                continue;
              }

              const candidateText = (() => {
                const lastUserMsg = [...candidate.item.messages].reverse().find(m => m.role === "user");
                return lastUserMsg?.content ?? "";
              })();

              api.logger.info(`capture-processor: LLM verdict ACCEPTED → storing key=${result.key}, value="${result.value.slice(0, 50)}${result.value.length > 50 ? '...' : ''}"`);

              if (config.core.humanReviewRequired) {
                proposalQueue.enqueue({
                  category: result.key.split(".")[0] || "general",
                  text: candidateText,
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
                  metadata: { reason: result.reason, original_text: candidateText },
                });
              }
            }
          }

          // Write approved items to free-text memory
          for (let j = 0; j < llmCandidates.length; j++) {
            if (!approvedPositions.has(j)) {
              api.logger.info(`capture-processor: LLM omitted/discard [${j}] → skipping outbox`);
              continue;
            }
            const candidate = llmCandidates[j];
            const lastUserMsg = [...candidate.item.messages].reverse().find(m => m.role === "user");
            const itemText = lastUserMsg?.content ?? "";
            if (isKnowledgeDump(itemText)) {
              api.logger.info(`capture-processor: quality-reject [${j}] (knowledge-dump) → skipping outbox`);
              continue;
            }
            outbox.enqueue(
              candidate.item.messages,
              candidate.item.scope,
              buildFreeTextMetadata(itemText, candidate.item.scope, { captureKind: "auto" }),
            );
            api.logger.info(`capture-processor: LLM approved [${j}] → outbox`);
          }
        } else {
          api.logger.info(`capture-processor: no candidates for LLM gate`);
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
            await coreRepo.consolidate(scope, {
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
    sync.registerAgent(bootstrapAgentId, resolveWorkspaceDir(bootstrapAgentId), { schedule: false });

    api.logger.info(
      `memory-mem0: registered (core=local, freeText=${config.backend.freeText.provider}, userId: ${config.scope.userId}, agentId: ${config.scope.agentId}, recall: ${config.recall.enabled}, capture: ${config.capture.enabled}, classifier: ${config.classifier.enabled !== false})`,
    );

    // ========================================================================
    // Hooks
    // ========================================================================

    // Smart Router: select model based on query complexity tier
    if (config.smartRouter.enabled && classifier) {
      api.on("before_model_resolve", createSmartRouterHook(classifier, inbound, config, api.logger), {
        priority: HOOK_PRIORITY.smartRouter,
      });
    }

    if (config.recall.enabled || config.core.enabled) {
      api.on("before_prompt_build", createRecallHook(primaryFreeTextBackend, scopeResolver, coreRepo, cache, inbound, config, api.logger, metrics, sync, classifier), {
        priority: HOOK_PRIORITY.recall,
      });
    }

    if (config.capture.enabled) {
      api.on("agent_end", createCaptureHook(outbox, coreRepo, proposalQueue, cache, config, api.logger, metrics, sync, candidateQueue, inbound, captureDedupStore), {
        priority: HOOK_PRIORITY.capture,
      });
    }

    api.on("message_received", createMessageReceivedHook(inbound, api.logger), {
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
        consolidationScheduler,
      ),
    );

    // ========================================================================
    // Service lifecycle
    // ========================================================================

    api.registerService({
      id: "memory-mem0",
      start: async (_ctx: unknown) => {
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

        // Start consolidation scheduler
        if (config.core.consolidation.enabled) {
          consolidationScheduler.start();
        }

        api.logger.info("memory-mem0: service started");
      },
      stop: async (_ctx: unknown) => {
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
        consolidationScheduler.stop();
        cache.clear();

        api.logger.info("memory-mem0: service stopped");
      },
    });
  },
};

export default memoryMemuPlugin;
