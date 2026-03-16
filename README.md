# @openclaw/memory-mem0

**Dual-layer long-term memory plugin for OpenClaw** — local Core Memory + remote free-text vector search via [mem0](https://github.com/mem0ai/mem0).

Automatically recalls relevant memories before prompt building, and captures durable facts from conversations for future use. Chinese-first design with full CJK tokenization, numeral normalization, and semantic reranking.

## Highlights

- **Dual-Layer Architecture** — structured Core Memory (local JSON K/V) for high-confidence facts + free-text vector memory (mem0) for long-tail knowledge. Core Memory is always injected; free-text is retrieved on demand.
- **88.6% End-to-End Recall** on a 70-case benchmark covering profiles, goals, preferences, constraints, technical configs, and architecture decisions — significantly outperforming the official mem0 plugin's 35.7%.
- **LLM Admission Gate** — optional Gemini-powered quality filter classifies candidate memories as `core` / `free_text` / `discard` before storage, eliminating noise.
- **Async Capture Pipeline** — `CandidateQueue → LLM Gate → Outbox → mem0`, with hash-based dedup, batch processing, retry with backoff, and disk persistence. Zero impact on agent response latency.
- **Chinese-First** — CJK bigram tokenization, Chinese numeral normalization (第一 ↔ 1), and cross-language semantic matching.
- **Multi-Agent / Multi-Tenant** — full scope isolation via `userId + agentId + sessionKey + tenantId`. Per-agent userId mapping for shared deployments.
- **9 Agent Tools** — `memory_recall`, `memory_store`, `memory_forget`, `memory_stats`, `memory_core_list`, `memory_core_upsert`, `memory_core_delete`, `memory_core_touch`, `memory_core_proposals`.
- **CLI Dashboard** — `/memu status`, `/memu search`, `/memu flush`, `/memu dashboard`, `/memu audit`.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw Agent                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  before_prompt_build          agent_end / message_recv  │
│         │                            │                  │
│         ▼                            ▼                  │
│  ┌─────────────┐            ┌────────────────┐          │
│  │ Recall Hook │            │ Capture Hook   │          │
│  │             │            │                │          │
│  │ 1. Extract  │            │ 1. Filter      │          │
│  │    query    │            │    (low-signal, │          │
│  │ 2. Search   │            │     injection)  │          │
│  │    both     │            │ 2. Dedup       │          │
│  │    layers   │            │ 3. Enqueue     │          │
│  │ 3. Rerank   │            └───────┬────────┘          │
│  │ 4. Dedup    │                    │                   │
│  │ 5. Inject   │                    ▼                   │
│  └─────────────┘            ┌────────────────┐          │
│         │                   │ CandidateQueue │          │
│         ▼                   │ (batch timer)  │          │
│  ┌─────────────┐            └───────┬────────┘          │
│  │   Context   │                    │                   │
│  │  Injection  │                    ▼                   │
│  │             │            ┌────────────────┐          │
│  │ <core-      │            │  LLM Gate      │          │
│  │  memory>    │            │  (Gemini)      │          │
│  │ <relevant-  │            │                │          │
│  │  memories>  │            │ core/free_text │          │
│  └─────────────┘            │ /discard       │          │
│                             └──┬─────────┬───┘          │
│                                │         │              │
│                   ┌────────────┘         └──────┐       │
│                   ▼                             ▼       │
│           ┌──────────────┐            ┌──────────────┐  │
│           │ Core Memory  │            │   Outbox     │  │
│           │ (local JSON) │            │ (async queue │  │
│           │              │            │  retry/batch)│  │
│           │ profile tier │            └──────┬───────┘  │
│           │ technical    │                   │          │
│           │ general      │                   ▼          │
│           └──────────────┘            ┌──────────────┐  │
│                                       │  mem0 API    │  │
│                                       │ (vector DB)  │  │
│                                       └──────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Memory Tiers

| Tier | Storage | Injection | Use Case |
|------|---------|-----------|----------|
| **profile** | Core Memory (local) | Always injected | Identity, preferences, goals, relationships |
| **technical** | Core Memory (local) | Retrieval-only | Tech configs, architecture, decisions |
| **general** | Core Memory (local) | Always injected | Other high-confidence facts |
| **free-text** | mem0 (remote) | On-demand recall | Long-tail knowledge, lessons learned |

## Benchmark: vs Official mem0 Plugin

70-case end-to-end recall benchmark. Same memory corpus, same queries, same LLM.

| Metric | memory-mem0 (ours) | @mem0/openclaw-mem0 (official) |
|--------|---:|---:|
| **Recall Hit Rate** | **88.6%** (62/70) | 35.7% (25/70) |
| Avg Response Time | 12.6s | 24.5s |
| P95 Response Time | 14.8s | 31.2s |

### Why the Difference?

| Factor | This Plugin | Official Plugin |
|--------|-------------|-----------------|
| Core Memory | Local JSON with tiered injection | None (free-text only) |
| Query Understanding | Tokenization + semantic rerank + Chinese normalization | Raw vector search |
| Structured Facts | Regex + LLM gate extract to K/V | Relies on mem0's add rewriting |
| Session Dedup | Per-session injection tracking | N/A |
| Context Budget | Controlled injection with priority | Unranked flat injection |

### Benchmark Categories

| Category | Cases | Hit Rate |
|----------|------:|------:|
| Profile (name, city, job, MBTI) | 10 | 100% |
| Goals (career, health, interests) | 8 | 87.5% |
| Preferences (communication, tools) | 12 | 91.7% |
| Constraints (privacy, delete rules) | 7 | 85.7% |
| Technical configs (models, latency) | 14 | 57.1% |
| Architecture (4-layer design) | 9 | 55.6% |
| Cross-category / compound | 4 | 75.0% |
| Rephrased / conversational | 6 | 83.3% |

> Technical and architecture facts have lower hit rates because mem0's `add` API rewrites content during storage (translates to English, loses numerical precision like "120ms" or "3072"). This is a mem0 backend limitation, not a recall-layer issue.

### Recall Improvement Timeline

| Version | Hit Rate | Key Changes |
|---------|------:|-------------|
| Baseline (official plugin) | 35.7% | Free-text only, no core memory |
| + Core Memory + reranking | 75.7% | Local K/V store, semantic rerank |
| + Capture pipeline fix | 78.6% | CLI mode capture, LLM gate, dedup fix |
| + Unified intent classifier | 88.6% | Smart query routing, embedding bge-m3 |
| + Pre-populated corpus | 92.9% | All facts pre-stored (upper bound) |

## Quick Start

### 1. Install

```bash
cp -r memory-mem0 ~/.openclaw/extensions/memory-mem0
cd ~/.openclaw/extensions/memory-mem0 && npm install
```

### 2. Configure

Add to `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "memory-mem0": {
        "enabled": true,
        "config": {
          // Simplified top-level config (recommended)
          "dataDir": "~/.openclaw/data/memory-mem0",
          "geminiApiKey": "YOUR_GEMINI_API_KEY",  // Shared for classifier, llmGate, mem0 LLM

          "mem0": {
            "mode": "open-source",
            "oss": {
              "llm": {
                "provider": "google",
                "config": { "model": "gemini-2.5-flash" }  // apiKey inherited from geminiApiKey
              },
              "embedder": {
                "provider": "ollama",
                "config": { "model": "bge-m3:latest", "embeddingDims": 1024 }
              },
              "vectorStore": {
                "provider": "qdrant",
                "config": { "host": "localhost", "port": 6333 }
              }
            }
          },
          "scope": {
            "userId": "your-user-id"
          }
        }
      }
    }
  }
}
```

### 3. Verify

```bash
openclaw gateway restart
openclaw agent --agent main --message "记住我叫张三，我是后端工程师"
openclaw agent --agent main --message "我叫什么名字？"
```

See [INSTALL.md](./INSTALL.md) for full configuration reference.

## Project Structure

```
├── index.ts                  # Plugin entry, lifecycle management
├── hooks/
│   ├── recall.ts             # before_prompt_build — search + inject
│   ├── capture.ts            # agent_end — extract + queue
│   └── message-received.ts   # Per-message tracking
├── tools/                    # 9 agent tools (recall, store, forget, etc.)
├── backends/free-text/
│   ├── base.ts               # FreeTextBackend interface
│   ├── factory.ts            # Provider factory
│   └── mem0.ts               # mem0 platform + OSS implementation
├── core-repository.ts        # Local Core Memory K/V store
├── core-admission.ts         # LLM gate (Gemini classifier)
├── core-proposals.ts         # Regex extraction + human review queue
├── candidate-queue.ts        # Batched capture queue with dedup
├── outbox.ts                 # Async write queue with retry/backoff
├── cache.ts                  # LRU cache with TTL
├── classifier.ts             # Unified intent classifier (query type, tier)
├── smart-router.ts           # Model routing based on query complexity
├── metadata.ts               # Tokenization, Chinese numerals, ranking
├── security.ts               # Injection detection, XML escaping
├── sync.ts                   # Markdown export to workspaces
├── metrics.ts                # Runtime telemetry
├── cli.ts                    # /memu CLI commands
├── types.ts                  # Config schema + defaults
├── scripts/                  # Benchmarks, backfill, comparison tools
└── tests/                    # 25+ test files, 70+ E2E lifecycle cases
```

## Running Tests

```bash
# Unit tests
npx tsx tests/cache.test.ts
npx tsx tests/core-repository.test.ts
npx tsx tests/metadata.test.ts
npx tsx tests/security.test.ts
npx tsx tests/classifier.test.ts           # Unified intent classifier
npx tsx tests/smart-router.test.ts         # Smart model routing
npx tsx tests/inbound-cache.test.ts        # Classification caching

# Integration tests
npx tsx tests/e2e-lifecycle.test.ts          # 63 cases
npx tsx tests/capture-fallback.test.ts       # 12 cases

# Benchmarks
npx tsx scripts/run-e2e-ingest-and-benchmark.ts         # Full E2E pipeline
npx tsx scripts/run-plugin-recall-comparison.ts          # vs official plugin
npx tsx scripts/run-agent-plugin-e2e-comparison.ts       # Agent-level comparison
```

## Key Design Decisions

1. **Core Memory is local, not remote** — structured facts in a JSON file provide deterministic, zero-latency recall for high-confidence information. No network dependency for "what's the user's name".

2. **Capture is async and best-effort** — the `CandidateQueue → Outbox` pipeline never blocks agent responses. Failed captures are dropped (not retried indefinitely) because fresh messages will re-capture the same facts.

3. **LLM gate is optional** — regex patterns catch ~60% of core facts (identity, preferences, goals). The LLM gate catches the remaining 40% (technical configs, architecture). Both paths can work independently.

4. **Chinese-first tokenization** — CJK text doesn't have word boundaries. The metadata layer uses bigram tokenization and Chinese numeral normalization to enable accurate semantic matching.

5. **Session-level dedup** — prevents re-injecting the same memory within a conversation, keeping context budgets tight.

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `mem0ai` | ^2.3.0 | Free-text vector memory backend |
| OpenClaw SDK | peer | Plugin host runtime |

## License

MIT
