# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

**@openclaw/memory-mem0** — A TypeScript plugin for OpenClaw that provides dual-layer long-term memory (local core memory + remote free-text via mem0). It automatically injects recalled memories before prompt building and captures durable facts after agent runs.

## Running Tests

There is no test runner or npm scripts. Tests use a custom async/await framework with `npx tsx`:

```bash
# Run a single test
npx tsx tests/cache.test.ts

# Run E2E benchmark (63 cases)
npx tsx tests/turning-zero-e2e-benchmark.test.ts

# Run benchmark scripts
npx tsx scripts/run-turning-zero-e2e-benchmark.ts
```

Tests output `✓`/`✗` per case. No linter is configured; TypeScript strict mode (`tsconfig.json`) provides static checks.

## Build

No explicit build step. OpenClaw loads `index.ts` directly via `"openclaw.extensions": ["./index.ts"]` in `package.json`. Output dir `./dist` is configured in tsconfig but not used at runtime.

## Architecture

### Two Memory Layers

- **Core Memory** (`core-repository.ts`) — local JSON file store for high-confidence structured facts. Persisted to `~/.openclaw/data/memory-mem0/`.
- **Free-Text Memory** (`backends/free-text/mem0.ts`) — remote vector search via mem0 (platform or open-source mode). Abstracted behind `FreeTextBackend` interface in `backends/free-text/base.ts`.

### Plugin Lifecycle (index.ts)

`register()` wires everything: config → core modules → hooks → tools → commands → service start/stop. All components receive shared instances (cache, metrics, outbox, scopeResolver).

### Hook Pipeline

1. **Recall** (`hooks/recall.ts`, `before_prompt_build`) — Extracts query from messages, searches both memory layers, reranks/deduplicates, injects into prompt context. Session-level dedup prevents re-injecting the same memory.
2. **Capture** (`hooks/capture.ts`, `agent_end`) — Extracts durable facts from conversation, filters low-signal content, queues to outbox for async write to mem0.
3. **Message Received** (`hooks/message-received.ts`) — Tracks inbound messages in `InboundMessageCache` for capture dedup.

### Async Outbox (`outbox.ts`)

Decouples capture from backend writes. Provides batch processing, retry with backoff, dead-letter handling, and disk persistence.

### Supporting Modules

- `cache.ts` — LRU cache with TTL for recall results
- `metadata.ts` — Query tokenization, semantic ranking, Chinese numeral normalization
- `security.ts` — XML escaping, prompt injection detection
- `core-proposals.ts` — Proposal queue for human-reviewed core memory extraction
- `sync.ts` — Periodic Markdown export of memories to agent workspaces
- `workspace-facts.ts` — File-based fallback memory from workspace files
- `cli.ts` — `/memu` commands (status, search, flush, dashboard, audit)

### Scope System

All operations are scoped via `MemoryScope` (userId, agentId, sessionKey, tenantId). Multi-agent setups use per-agent userId mapping via `scope.userIdByAgent`.

### Tools (tools/)

Factory pattern — each tool creator receives shared runtime context. Tools: `memory_recall`, `memory_store`, `memory_forget`, `memory_stats`, `memory_core_list`, `memory_core_upsert`, `memory_core_delete`, `memory_core_touch`, `memory_core_proposals`.

## Key Conventions

- ES modules (`"type": "module"` in package.json), `.js` extensions in imports (even for `.ts` files)
- Single production dependency: `mem0ai`. OpenClaw SDK is a peer dependency provided by host.
- Config schema defined in `openclaw.plugin.json` and loaded/defaulted in `types.ts`
- Chinese language support is first-class (numeral normalization, tokenization in `metadata.ts`)
