# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**@openclaw/memory-mem0** — A TypeScript plugin for OpenClaw that provides dual-layer long-term memory (local core memory + remote free-text via mem0). It automatically injects recalled memories before prompt building and captures durable facts after agent runs. Chinese-first design with full CJK tokenization and numeral normalization.

## Commands

```bash
# Type checking (no linter configured)
npm run typecheck          # tsc --noEmit

# Run a single test (custom async/await framework, no test runner)
npx tsx tests/cache.test.ts

# Regression suite (compiles to /tmp then runs via node)
npm run test:regression

# E2E benchmark (70 cases)
npx tsx tests/turning-zero-e2e-benchmark.test.ts

# Benchmark scripts
npx tsx scripts/run-e2e-ingest-and-benchmark.ts
npx tsx scripts/run-plugin-recall-comparison.ts
```

Tests output `✓`/`✗` per case. No build step — OpenClaw loads `index.ts` directly via `"openclaw.extensions"` in `package.json`.

## Architecture

### Two Memory Layers

- **Core Memory** (`core-repository.ts`) — local JSON K/V store for high-confidence structured facts. Persisted to `~/.openclaw/data/memory-mem0/`. Three tiers: `profile` (always injected), `technical` (retrieval-only), `general` (always injected).
- **Free-Text Memory** (`backends/free-text/mem0.ts`) — remote vector search via mem0 (platform or open-source mode). Abstracted behind `FreeTextBackend` interface in `backends/free-text/base.ts`. Used for long-tail knowledge.

### Plugin Lifecycle (index.ts)

`register()` wires everything: config → core modules → hooks → tools → commands → service start/stop. All components receive shared instances (cache, metrics, outbox, scopeResolver). Singleton guard via `WeakSet<object>` prevents duplicate registration.

### Hook Pipeline

1. **Smart Router** (`hooks/smart-router.ts`, priority 200) — Optional tier-based model routing. Routes requests by complexity tier (SIMPLE/MEDIUM/COMPLEX/REASONING) to best-fit model.
2. **Recall** (`hooks/recall.ts`, `before_prompt_build`, priority 100) — Extracts query from messages, searches both memory layers in parallel, reranks/deduplicates, injects into prompt context via `<core-memory>` and `<relevant-memories>` tags. 30-second time-window dedup prevents re-injecting the same memory within a session.
3. **Capture** (`hooks/capture.ts`, `agent_end`, priority 100) — Extracts durable facts from conversation window (up to N recent turns), filters low-signal content (greetings, temporal, test mentions), strips previously injected memory blocks. Routes candidates through the capture pipeline (see below).
4. **Message Received** (`hooks/message-received.ts`, priority 100) — Tracks inbound messages in `InboundMessageCache` for capture dedup.

### Capture Pipeline (Candidate → Storage)

Candidates follow one of three paths based on classification and config:

1. **Regex match** → write directly to Core Memory (bypasses LLM gate)
2. **LLM gate disabled or classification hint="light"** → write directly to free-text Outbox
3. **Full classification** → `CandidateQueue` → batch to `judgeCandidates()` in `core-admission.ts` → LLM returns verdict (`core` / `free_text` / `discard`) → route accordingly

The LLM gate (`core-admission.ts`) uses OpenAI-compatible chat completions (supports Kimi, Gemini, OpenAI, Ollama). Inflight dedup via module-level map prevents concurrent duplicate API calls for identical batches.

### Async Outbox (`outbox.ts`)

Decouples capture from backend writes. Batch processing, retry with exponential backoff, dead-letter queue for permanently failed items, and disk persistence (resume on restart). Zero impact on agent response latency.

### Consolidation (`consolidation/`)

Separate scheduled service (not part of capture/recall) that periodically cleans up stale/duplicate core memories. Components: `runner.ts` (execute dry-run or live), `scheduler.ts` (daily/weekly patterns), `scorer.ts` (score by age, access patterns, similarity), `llm-consolidator.ts` (optional LLM-based consolidation).

### Inflight Dedup Pattern

Both the recall hook and LLM gate use module-level `Map` objects to deduplicate concurrent identical requests. When multiple hook instances fire concurrently with the same query/batch, only one API call is made; others await the same promise. This prevents thundering herd on backend APIs.

### Scope System

All operations are scoped via `MemoryScope` (userId, agentId, sessionKey, tenantId). Multi-agent setups use per-agent userId mapping via `scope.userIdByAgent`. Free-text backend uses `userId` as primary key; core memory enforces the full `userId + agentId + tenantId` tuple.

### Tools (tools/)

Factory pattern — each tool creator receives shared runtime context (primaryBackend, cache, config, metrics, scopeResolver, coreRepo). Nine tools: `memory_recall`, `memory_store`, `memory_forget`, `memory_stats`, `memory_core_list`, `memory_core_upsert`, `memory_core_delete`, `memory_core_touch`, `memory_core_proposals`.

## Key Conventions

- ES modules (`"type": "module"` in package.json), `.js` extensions in imports (even for `.ts` files)
- Single production dependency: `mem0ai`. OpenClaw SDK is a peer dependency provided by host.
- `patch-package` patches mem0ai on `npm install` (see `patches/` directory) — currently sanitizes entity type names in knowledge graph builder
- Config schema defined in `openclaw.plugin.json` and loaded/defaulted in `types.ts`
- Chinese language support is first-class (CJK bigram tokenization, numeral normalization 第一 ↔ 1, cross-language semantic matching in `metadata.ts`)
- Classification types in `types.ts`: `QueryType` (greeting/code/debug/factual/preference/planning/open), `CaptureHint` (skip/light/full), complexity tiers (SIMPLE/MEDIUM/COMPLEX/REASONING)
