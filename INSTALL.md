# memory-mem0 安装指南

> 本文档以 [README.zh-CN.md](./README.zh-CN.md) 为准，并补充可执行的安装与验证步骤。配置字段、默认值和命令说明优先遵循 README.zh-CN 的口径。

## 1. 推荐安装路径

当前仓库最推荐的组合是：

- OpenClaw 直接加载仓库里的 `index.ts`
- Free-text Memory 使用 mem0 OSS
- 向量库使用 Qdrant
- Embedding 使用 Ollama `bge-m3:latest`
- mem0 / classifier / LLM Gate 默认共用 `kimiApiKey`

如果只想先跑通，按下面的“最小可用安装”即可。

## 2. 系统要求

| 依赖 | 要求 | 说明 |
|------|------|------|
| macOS / Linux | 建议 | Windows 请使用 WSL2 |
| Node.js | 18+ | 仓库当前要求 `engines.node >=18` |
| npm | 可用 | `npm install` 会触发 `patch-package` |
| OpenClaw | 支持 memory 插件 | 通过 `plugins.entries` 加载 |
| Qdrant | 必需（OSS 模式） | free-text 向量存储 |
| Ollama | 必需（OSS 模式） | embedding；也可作为本地 LLM |
| Kimi Coding API Key | 推荐 | classifier / llmGate / mem0 LLM 共用 |
| Neo4j | 可选 | 仅 `mem0.enableGraph=true` 时需要 |

说明：

- 本仓库没有单独 build 步骤，OpenClaw 运行时直接读取 `package.json` 中的 `"openclaw.extensions": ["./index.ts"]`。
- 当前仓库提供 `npm run typecheck` 和 `npm run test:regression` 两个 npm script；其它测试按 `npx tsx <file>` 运行。

## 3. 最小可用安装

### 3.1 安装插件

```bash
mkdir -p ~/.openclaw/extensions
cd ~/.openclaw/extensions
git clone https://github.com/BreakDimbo/mem0-plugin-for-openclaw.git memory-mem0
cd memory-mem0
npm install
```

如果目录已经存在：

```bash
cd ~/.openclaw/extensions/memory-mem0
git pull
npm install
```

### 3.2 启动 Qdrant

```bash
mkdir -p ~/.qdrant/storage

docker run -d \
  --name qdrant \
  --restart unless-stopped \
  -p 6333:6333 \
  -p 6334:6334 \
  -v ~/.qdrant/storage:/qdrant/storage \
  qdrant/qdrant:v1.13.6
```

验证：

```bash
curl http://localhost:6333/collections
```

### 3.3 启动 Ollama 并拉取 embedding 模型

macOS：

```bash
brew install ollama
brew services start ollama
```

Linux：

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama serve
```

拉取推荐模型：

```bash
ollama pull bge-m3:latest
```

验证：

```bash
ollama list
curl http://localhost:11434/api/embeddings -d '{
  "model": "bge-m3:latest",
  "prompt": "测试向量生成"
}'
```

## 4. OpenClaw 配置

编辑 `~/.openclaw/openclaw.json`，将插件加入 `plugins.entries`。

说明：

- 当前代码和 `README.zh-CN.md` 都以 `plugins.entries.memory-mem0.config` 这一路径为主。
- `INSTALL.md` 不再额外要求配置 `plugins.slots.memory`，因为 `README.zh-CN.md` 当前最小/完整配置都没有这一步。
- 如果你的 OpenClaw 版本或宿主配置策略要求显式绑定 memory slot，再按宿主侧要求补充；这不属于本插件仓库当前代码要求。

### 4.1 最小配置

这一段直接对齐 `README.zh-CN.md` 的“最小配置”。

```jsonc
{
  "plugins": {
    "entries": {
      "memory-mem0": {
        "enabled": true,
        "config": {
          "dataDir": "~/.openclaw/data/memory-mem0",
          "kimiApiKey": "YOUR_KIMI_CODING_API_KEY",
          "mem0": {
            "mode": "open-source",
            "oss": {
              "llm": {
                "provider": "kimi_coding",
                "config": { "model": "k2p5" }
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
          "scope": { "userId": "your-user-id" }
        }
      }
    }
  }
}
```

### 4.2 完整配置

这一段同样直接对齐 `README.zh-CN.md` 当前“完整配置”的字段和默认值。

说明：

- 这里的字段名和默认值以 `README.zh-CN.md`、`openclaw.plugin.json` 与 `types.ts` 当前实现共同对齐。
- 其中 `core.llmGate.maxTokensPerBatch` 当前真实默认值已与文档保持一致，为 `4000`。

```jsonc
{
  "plugins": {
    "entries": {
      "memory-mem0": {
        "enabled": true,
        "config": {
          "dataDir": "~/.openclaw/data/memory-mem0",
          "kimiApiKey": "YOUR_KEY",

          "mem0": {
            "mode": "open-source",
            "enableGraph": false,
            "searchThreshold": 0.3,
            "topK": 5,
            "customInstructions": "",
            "oss": {
              "embedder":   { "provider": "ollama",      "config": { "model": "bge-m3:latest", "embeddingDims": 1024 } },
              "vectorStore":{ "provider": "qdrant",      "config": { "host": "localhost", "port": 6333 } },
              "llm":        { "provider": "kimi_coding", "config": { "model": "k2p5" } },
              "historyDbPath": "~/.openclaw/data/memory-mem0/memory.db"
            }
          },

          "scope": {
            "userId": "your-user-id",
            "agentId": "main",
            "userIdByAgent": {
              "agent_a": "user_a",
              "agent_b": "user_b"
            }
          },

          "recall": {
            "enabled": true,
            "topK": 5,
            "threshold": 0.25,
            "maxChars": 1500,
            "cacheTtlMs": 60000,
            "cacheMaxSize": 100
          },

          "core": {
            "enabled": true,
            "topK": 10,
            "maxItemChars": 300,
            "autoExtractProposals": true,
            "humanReviewRequired": false,
            "touchOnRecall": true,
            "alwaysInjectTiers": ["profile", "general"],
            "alwaysInjectLimit": 800,

            "consolidation": {
              "enabled": true,
              "intervalMs": 3600000,
              "similarityThreshold": 0.85,
              "weights": {
                "recency": 0.30, "accessFreq": 0.20, "novelty": 0.20,
                "typePrior": 0.15, "explicitImportance": 0.15
              },
              "decay": { "stabilityDays": 14 },
              "thresholds": {
                "keep": 0.65, "downgrade": 0.45, "archive": 0.25, "delete": 0.10,
                "llmLow": 0.35, "llmHigh": 0.55
              },
              "schedule": {
                "daily":   { "enabled": true, "hourOfDay": 3 },
                "weekly":  { "enabled": true, "hourOfDay": 4, "dayOfWeek": 1 },
                "monthly": { "enabled": true, "hourOfDay": 5, "dayOfMonth": 1 }
              },
              "llm": {
                "enabled": false,
                "apiBase": "http://localhost:11434/v1",
                "model": "qwen2.5:14b",
                "timeoutMs": 30000,
                "maxBatchSize": 20
              }
            },

            "llmGate": {
              "enabled": false,
              "apiBase": "https://api.kimi.com/coding/",
              "model": "k2p5",
              "maxTokensPerBatch": 4000,
              "timeoutMs": 60000
            }
          },

          "capture": {
            "enabled": true,
            "minChars": 20,
            "maxChars": 600,
            "maxConversationTurns": 6,
            "dedupeThreshold": 0.8,
            "candidateQueue": {
              "enabled": true,
              "intervalMs": 10000,
              "maxBatchSize": 50
            }
          },

          "outbox": {
            "enabled": true,
            "concurrency": 2,
            "batchSize": 10,
            "maxRetries": 5,
            "drainTimeoutMs": 5000,
            "flushIntervalMs": 10000
          },

          "sync": {
            "enabled": true,
            "intervalMs": 300000,
            "memoryFilePath": "MEMORY.md"
          },

          "classifier": {
            "enabled": true,
            "model": "k2p5",
            "apiBase": "https://api.kimi.com/coding/",
            "cacheTtlMs": 300000,
            "cacheMaxSize": 200
          },

          "smartRouter": {
            "enabled": false,
            "tierModels": {
              "SIMPLE": "gemini-2.0-flash-lite",
              "MEDIUM": "gemini-2.5-flash",
              "COMPLEX": "gemini-2.5-pro",
              "REASONING": "claude-sonnet-4-6"
            }
          },

          "dreaming": {
            "enabled": false,
            "schedule": { "hourOfDay": 4 },
            "scoring": {
              "weights": {
                "frequency": 0.24,
                "relevance": 0.30,
                "diversity": 0.15,
                "recency": 0.15,
                "consolidation": 0.10,
                "conceptual": 0.06
              },
              "promotion": {
                "minScore": 0.75,
                "minRecallCount": 3,
                "minUniqueQueries": 2
              }
            },
            "maxSignalEntries": 500,
            "maxPromotionsPerCycle": 5,
            "llmDiary": false
          }
        }
      }
    }
  }
}
```

### 4.3 常见调优建议

这部分同步 README.zh-CN 当前建议值。

| 场景 | 参数 | 建议值 |
|------|------|--------|
| 中文召回准确率低 | `recall.threshold` | 0.20–0.25 |
| 记忆噪音多 | `core.llmGate.enabled` | `true` |
| 人工控制写入 | `core.humanReviewRequired` | `true` |
| 捕获窗口过长 | `capture.maxConversationTurns` | 3–4 |
| 整理过于激进 | `consolidation.decay.stabilityDays` | 增大（如 21） |
| 整理不够及时 | `consolidation.decay.stabilityDays` | 减小（如 7–10） |
| LLM 裁决太多 | `consolidation.thresholds.llmLow/High` | 收窄区间 |
| Dreaming 晋升太保守 | `dreaming.scoring.promotion.minScore` | 0.70 |
| Dreaming 晋升太激进 | `dreaming.scoring.promotion.minScore` | 0.80 |

### 4.4 启用 Graph Memory

仅当你需要 mem0 graph memory 时，才需要 Neo4j。

```bash
mkdir -p ~/.neo4j/data ~/.neo4j/logs

docker run -d \
  --name neo4j \
  --restart unless-stopped \
  -p 7474:7474 \
  -p 7687:7687 \
  -v ~/.neo4j/data:/data \
  -v ~/.neo4j/logs:/logs \
  -e NEO4J_AUTH=neo4j/your-password \
  -e NEO4J_PLUGINS='["apoc"]' \
  neo4j:latest
```

对应配置示例：

```jsonc
{
  "mem0": {
    "mode": "open-source",
    "enableGraph": true,
    "oss": {
      "llm": {
        "provider": "kimi_coding",
        "config": { "model": "k2p5" }
      },
      "embedder": {
        "provider": "ollama",
        "config": { "model": "bge-m3:latest", "embeddingDims": 1024 }
      },
      "vectorStore": {
        "provider": "qdrant",
        "config": { "host": "localhost", "port": 6333 }
      },
      "graph_store": {
        "provider": "neo4j",
        "config": {
          "url": "bolt://localhost:7687",
          "username": "neo4j",
          "password": "your-password"
        }
      }
    }
  }
}
```

说明：

- README.zh-CN 当前建议优先在 `oss.llm` 中配置 `kimi_coding`。
- 启用 `enableGraph` 时，通常不需要额外单配 `oss.graph_store.llm`。

### 4.5 完全本地化 LLM

如果不想依赖 Kimi，可以把 mem0 的 LLM、`core.llmGate`、`classifier` 和 `core.consolidation.llm` 都切到 Ollama。

先拉模型：

```bash
ollama pull qwen2.5:7b
ollama pull qwen2.5:14b
```

配置示例：

```jsonc
{
  "mem0": {
    "mode": "open-source",
    "oss": {
      "llm": {
        "provider": "ollama",
        "config": {
          "model": "qwen2.5:7b",
          "url": "http://127.0.0.1:11434"
        }
      },
      "embedder": {
        "provider": "ollama",
        "config": {
          "model": "bge-m3:latest",
          "embeddingDims": 1024,
          "url": "http://127.0.0.1:11434"
        }
      },
      "vectorStore": {
        "provider": "qdrant",
        "config": { "host": "localhost", "port": 6333 }
      }
    }
  },
  "core": {
    "llmGate": {
      "enabled": true,
      "apiBase": "http://localhost:11434/v1",
      "model": "qwen2.5:7b"
    },
    "consolidation": {
      "llm": {
        "enabled": true,
        "apiBase": "http://localhost:11434/v1",
        "model": "qwen2.5:14b"
      }
    }
  },
  "classifier": {
    "enabled": true,
    "apiBase": "http://localhost:11434/v1",
    "model": "qwen2.5:7b"
  }
}
```

## 5. 安装后验证

### 5.1 校验依赖和类型

```bash
cd ~/.openclaw/extensions/memory-mem0
npm run typecheck
```

可选回归测试：

```bash
npm run test:regression
```

单文件测试示例：

```bash
npx tsx tests/cache.test.ts
npx tsx tests/e2e-lifecycle.test.ts
```

### 5.2 重启 OpenClaw

```bash
openclaw gateway restart
```

### 5.3 检查插件状态

在 OpenClaw 会话中执行：

```text
/memu status
```

预期能看到：

- Free-text Backend 正常在线
- 当前 `userId` / `agentId` / `sessionKey`
- Outbox、Cache、Core、Sync 的运行状态

补充说明：

- `/memu status` 是插件内注册的命令，来自 [cli.ts](/Users/Break/Documents/github/BreakDimbo/mem0-plugin-for-openclaw/cli.ts)。
- 文档不再使用 `openclaw plugins list` 作为主验证步骤，因为仓库代码真正暴露、且与插件行为直接相关的是 `/memu` 命令集。

### 5.4 做一次端到端记忆验证

```bash
openclaw agent --agent main --message "记住我叫张三，我是后端工程师，喜欢用 Go 语言"
```

等待 10 到 15 秒，再查询：

```bash
openclaw agent --agent main --message "我叫什么名字？"
openclaw agent --agent main --message "我的技术栈是什么？"
```

说明：当前写入链路是异步的，顺序为 `CandidateQueue -> LLM Gate -> Outbox -> mem0`。刚写入后立刻查不到，通常只是还没 flush 完。

## 6. 常用命令

### 6.1 OpenClaw 会话内命令

```text
/memu status
/memu search <query>
/memu flush
/memu dashboard
/memu audit
/memu core list
/memu core touch <id>
/memu consolidate status
/memu consolidate run daily --dry-run
/memu consolidate report 5
/memu consolidate run dreaming --dry-run
/memu consolidate dream-report
```

说明：

- 上面只列当前代码已确认存在、且适合安装后自检的高频命令。
- 更完整的 `/memu core ...`、`/memu consolidate ...` 子命令行为，以 [cli.ts](/Users/Break/Documents/github/BreakDimbo/mem0-plugin-for-openclaw/cli.ts) 和 `README.zh-CN.md` 为准。

### 6.2 仓库本地命令

```bash
npm run typecheck
npm run test:regression
npx tsx tests/cache.test.ts
npx tsx tests/e2e-lifecycle.test.ts
npx tsx scripts/tune-params.ts
```

## 7. 数据文件

这一节按 `README.zh-CN.md` 的“数据文件”同步：默认都位于 `~/.openclaw/data/memory-mem0/`，另有 workspace 下的 `MEMORY.md`。

边界说明：

- `core-memory.json`、`outbox-queue.json`、`outbox-deadletter.json`、`candidate-queue.json`、`core-proposals.json`、`inbound-message-cache.json` 都已在源码中有明确落盘路径。
- `memory.db` 只有在你按配置显式设置 `mem0.oss.historyDbPath` 时才会出现在对应位置；文档里的路径是推荐值，不是代码强制默认值。
- `MEMORY.md` 的写入位置取决于 `sync.memoryFilePath`。如果配置相对路径，例如 `MEMORY.md`，代码会把它解析到 agent workspace；如果配置绝对路径，则直接写入绝对路径。
- `dreaming-signals.json`、`dreaming-phase-signals.json`、`dream-diary.jsonl` 默认只在 `dreaming.enabled=true` 时有实际运行意义，但路径默认值确实由代码推导到 `dataDir` 下。

| 文件 | 内容 | 说明 |
|------|------|------|
| `core-memory.json` | Core Memory 主存储 | 直接可读 JSON，可手动编辑 |
| `outbox-queue.json` | 待发送队列 | 异常时可手动清空 |
| `outbox-deadletter.json` | Outbox 死信 | 需人工介入 |
| `candidate-queue.json` | 捕获候选缓冲 | 批处理前的暂存 |
| `core-proposals.json` | 人工审核队列 | `humanReviewRequired=true` 时使用 |
| `consolidation-dead-letter.jsonl` | 整理删除记录 | 可用于误删恢复 |
| `consolidation-state.json` | 整理调度状态 | 含最近运行与报告状态 |
| `dreaming-signals.json` | 召回信号存储 | 每次 recall 注入记录的原始信号 |
| `dreaming-phase-signals.json` | Phase 信号存储 | `lightHit` / `remHit` 跨周期累积 |
| `dream-diary.jsonl` | LLM 生成的 dreaming 日记 | `llmDiary=true` 时输出 |
| `memory.db` | mem0 SQLite 历史库 | mem0 OSS 内部使用 |
| `inbound-message-cache.json` | 入站消息缓存 | 辅助捕获去重 |
| `MEMORY.md`（workspace） | Markdown 同步输出 | Agent 启动时直接读取 |

## 8. 故障排查

### 8.1 Qdrant 不可用

现象：

- `/memu status` 里 free-text backend offline
- 日志出现 `Connection refused :6333`

排查：

```bash
docker ps | grep qdrant
curl http://localhost:6333/collections
```

### 8.2 Ollama 不可用

现象：

- embedding 失败
- 日志出现 `Connection refused :11434`

排查：

```bash
ollama list
curl http://localhost:11434/api/embeddings -d '{"model":"bge-m3:latest","prompt":"test"}'
```

### 8.3 `unable to open database file`

按照 README.zh-CN 当前说明，优先检查 `dataDir` 父目录是否存在且可写；`historyDbPath` 会自动展开 `~`。

```bash
mkdir -p ~/.openclaw/data/memory-mem0
```

### 8.4 `dimension mismatch`

一般是旧 collection 的向量维度与当前 embedding 模型不一致。

推荐维度：

- `bge-m3:latest` -> `1024`
- `nomic-embed-text:latest` -> `768`

### 8.5 LLM Gate 不工作

README.zh-CN 当前口径：检查 `core.llmGate.enabled=true` 且 `llmGate.apiKey` 已配置，或者顶层 `kimiApiKey` 已设置；无 key 时静默跳过。

### 8.6 刚写入的记忆查不到

这是正常误判高发场景。排查顺序：

1. 先等 10 到 15 秒
2. 看 `/memu status` 的 Outbox 是否仍有 pending
3. 执行 `/memu flush`
4. 再次查询

### 8.7 查看日志

```bash
tail -f ~/.openclaw/logs/gateway.log | grep memory-mem0
```

## 9. FAQ

本节只保留 README.zh-CN 中安装阶段最常见的问题。

**Q: 为什么有些内容没有被自动记忆？**

捕获会过滤低信号、过短/过长、重复或明显临时性的内容；这属于设计行为，不是安装故障。

**Q: Core Memory 会无限增长吗？**

不会。当前有 consolidation 调度器做周期整理，必要时还会进入 dead-letter 保护。

**Q: 整理 LLM 必须用 Qwen/Ollama 吗？**

不是。README.zh-CN 的当前口径是：支持任意 OpenAI-compatible 端点。

**Q: Dreaming 会把所有 free-text 都晋升成 Core Memory 吗？**

不会。Dreaming 只会晋升那些被反复召回、跨多天、跨多类 query 的高价值记忆。

**Q: 启用 Graph Memory 时 LLM 认证失败怎么办？**

优先按照 README.zh-CN 的建议，先在 `oss.llm` 中使用 `kimi_coding` provider；通常不需要单独配置 `oss.graph_store.llm`。

## 10. 参考资料

- [README.zh-CN.md](./README.zh-CN.md)
- [README.md](./README.md)
- [openclaw.plugin.json](./openclaw.plugin.json)
- [package.json](./package.json)

> 本文档已按 README.zh-CN 口径对齐，最后修订：2026-04-13
