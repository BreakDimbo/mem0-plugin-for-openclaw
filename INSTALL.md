# memory-mem0 完整安装指南

> 本文档面向 OpenClaw Agent 自动化安装，包含所有后端组件的完整部署流程。

---

## 目录

1. [系统要求](#1-系统要求)
2. [后端组件安装](#2-后端组件安装)
   - [2.1 Qdrant 向量数据库](#21-qdrant-向量数据库)
   - [2.2 Ollama 本地推理](#22-ollama-本地推理)
   - [2.3 Neo4j 图数据库（可选）](#23-neo4j-图数据库可选)
3. [插件安装](#3-插件安装)
4. [配置 OpenClaw](#4-配置-openclaw)
5. [验证安装](#5-验证安装)
6. [配置参考](#6-配置参考)
7. [故障排查](#7-故障排查)

---

## 1. 系统要求

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| **macOS / Linux** | — | Windows 需要 WSL2 |
| **Docker** | 20.10+ | 用于运行 Qdrant 和 Neo4j |
| **Node.js** | 18+ | 插件运行时（建议 25.x 以获得 FTS5 支持） |
| **Ollama** | 最新版 | 本地 Embedding 推理 |
| **OpenClaw** | 最新稳定版 | 需支持 `kind: "memory"` 插件 |

**API Key 要求：**

| Key | 用途 | 是否必须 |
|-----|------|---------|
| `kimiApiKey` | LLM（mem0 处理 + 意图分类 + LLM Gate） | 推荐 |
| OpenAI API Key | 如果使用 OpenAI 作为 LLM | 可选 |

---

## 2. 后端组件安装

### 2.1 Qdrant 向量数据库

Qdrant 是高性能向量数据库，用于存储和检索记忆的向量表示。

**Docker 安装（推荐）：**

```bash
# 创建数据目录（可选，用于持久化）
mkdir -p ~/.qdrant/storage

# 启动 Qdrant（推荐 v1.13.x 版本）
docker run -d \
  --name qdrant \
  --restart unless-stopped \
  -p 6333:6333 \
  -p 6334:6334 \
  -v ~/.qdrant/storage:/qdrant/storage \
  qdrant/qdrant:v1.13.6
```

**验证：**

```bash
# 检查容器状态
docker ps | grep qdrant

# 测试 API
curl http://localhost:6333/collections
# 应返回: {"result":{"collections":[]},"status":"ok","time":...}
```

**Homebrew 安装（macOS 替代方案）：**

```bash
brew install qdrant/tap/qdrant
qdrant --config-path ~/.qdrant/config.yaml
```

---

### 2.2 Ollama 本地推理

Ollama 提供本地 Embedding 模型推理，无需外部 API 调用。

**安装 Ollama：**

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# 或下载官方安装包
# https://ollama.com/download
```

**启动 Ollama 服务：**

```bash
# 启动服务（首次安装后通常自动启动）
ollama serve

# 或作为后台服务
brew services start ollama  # macOS
systemctl start ollama      # Linux (systemd)
```

**下载 Embedding 模型：**

```bash
# 推荐：bge-m3（中文优化，1024 维）
ollama pull bge-m3:latest

# 备选：nomic-embed-text（通用，768 维）
ollama pull nomic-embed-text:latest

# 可选：LLM 模型（如果不使用 Gemini）
ollama pull llama3.2:latest
ollama pull qwen2.5:7b
```

**验证：**

```bash
# 列出已安装模型
ollama list

# 测试 Embedding
curl http://localhost:11434/api/embeddings -d '{
  "model": "bge-m3:latest",
  "prompt": "测试向量生成"
}'
```

**模型维度参考：**

| 模型 | 维度 | 大小 | 推荐场景 |
|------|------|------|----------|
| `bge-m3:latest` | 1024 | 1.2GB | 中文/多语言（推荐） |
| `nomic-embed-text:latest` | 768 | 274MB | 英文/轻量 |
| `mxbai-embed-large:latest` | 1024 | 670MB | 通用 |

---

### 2.3 Neo4j 图数据库（可选）

Neo4j 用于 mem0 的 Graph Memory 功能，支持实体关系抽取和图谱查询。

**Docker 安装：**

```bash
# 创建数据目录
mkdir -p ~/.neo4j/data ~/.neo4j/logs

# 启动 Neo4j
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

> ⚠️ **重要**：将 `your-password` 替换为实际密码，并在插件配置中使用相同密码。

**验证：**

```bash
# 检查容器状态
docker ps | grep neo4j

# 访问 Neo4j Browser
open http://localhost:7474
# 使用 neo4j / your-password 登录
```

**Homebrew 安装（macOS 替代方案）：**

```bash
brew install neo4j
neo4j start
```

---

## 3. 插件安装

**方式一：从源码复制**

```bash
# 克隆仓库
git clone https://github.com/BreakDimbo/mem0-plugin-for-openclaw.git

# 复制到 OpenClaw 扩展目录
cp -r mem0-plugin-for-openclaw ~/.openclaw/extensions/memory-mem0

# 安装依赖
cd ~/.openclaw/extensions/memory-mem0
npm install
```

**方式二：直接克隆到扩展目录**

```bash
cd ~/.openclaw/extensions
git clone https://github.com/BreakDimbo/mem0-plugin-for-openclaw.git memory-mem0
cd memory-mem0 && npm install
```

**验证插件文件：**

```bash
ls ~/.openclaw/extensions/memory-mem0/
# 应包含: index.ts, types.ts, package.json, openclaw.plugin.json,
#         hooks/, tools/, backends/, tests/
```

---

## 4. 配置 OpenClaw

编辑 `~/.openclaw/openclaw.json`，添加插件配置：

### 4.1 最小配置（快速开始）

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
                "config": {
                  "model": "bge-m3:latest",
                  "embeddingDims": 1024
                }
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
    },
    "slots": {
      "memory": "memory-mem0"
    }
  }
}
```

### 4.2 完整配置（含 Graph Memory）

```jsonc
{
  "plugins": {
    "entries": {
      "memory-mem0": {
        "enabled": true,
        "config": {
          // =====================
          // 顶层简化配置
          // =====================
          "dataDir": "~/.openclaw/data/memory-mem0",
          "kimiApiKey": "YOUR_KIMI_CODING_API_KEY",

          // =====================
          // mem0 后端配置
          // =====================
          "mem0": {
            "mode": "open-source",
            "enableGraph": true,          // 启用 Graph Memory
            "searchThreshold": 0.25,      // 召回阈值（中文建议 0.20-0.25）
            "topK": 10,
            "oss": {
              // LLM 配置（用于 mem0 内部处理；推荐使用 mem0 原生 kimi_coding provider）
              "llm": {
                "provider": "kimi_coding",
                "config": { "model": "k2p5" }
                // apiKey 继承自顶层 kimiApiKey
              },
              // Embedding 配置
              "embedder": {
                "provider": "ollama",
                "config": {
                  "model": "bge-m3:latest",
                  "embeddingDims": 1024,
                  "url": "http://127.0.0.1:11434"
                }
              },
              // 向量存储
              "vectorStore": {
                "provider": "qdrant",
                "config": {
                  "host": "localhost",
                  "port": 6333
                }
              },
              // 历史记录存储
              "historyDbPath": "~/.openclaw/data/memory-mem0/history.db",
              // Graph Memory 配置（需要 Neo4j）
              "graph_store": {
                "provider": "neo4j",
                "config": {
                  "url": "bolt://localhost:7687",
                  "username": "neo4j",
                  "password": "your-password"
                }
              }
            },
            // 自定义捕获指令（中文）
            "customInstructions": "提取对话中可复用的持久知识，存储为独立的事实陈述。\n\n优先提取：\n- 用户画像：姓名、时区、位置、偏好、习惯、目标、约束\n- 工作上下文：项目、团队、技术栈、架构决策、工作流程\n- 重要指标：配置值、阈值、基准数据\n- 经验教训：稳定结论、重复模式、最佳实践\n\n排除：\n- 密钥、凭证、token 等敏感信息\n- 临时性问候、确认、填充语\n- 原始代码（除非是关键配置或决策）"
          },

          // =====================
          // 作用域隔离
          // =====================
          "scope": {
            "userId": "your-user-id"
          },

          // =====================
          // 召回配置
          // =====================
          "recall": {
            "enabled": true,
            "topK": 5,
            "threshold": 0.25,
            "maxChars": 2000,
            "cacheTtlMs": 60000,
            "cacheMaxSize": 100
          },

          // =====================
          // Core Memory 配置
          // =====================
          "core": {
            "enabled": true,
            "topK": 10,
            "maxItemChars": 300,
            "autoExtractProposals": true,
            "humanReviewRequired": false,
            "alwaysInjectTiers": ["profile", "general"],
            "alwaysInjectLimit": 800,
            "consolidation": {
              "enabled": true,
              "intervalMs": 3600000,
              "similarityThreshold": 0.85
            },
            "llmGate": {
              "enabled": true,
              "model": "gemini-2.5-flash",
              "maxTokensPerBatch": 4000,
              "timeoutMs": 60000
            }
          },

          // =====================
          // 捕获配置
          // =====================
          "capture": {
            "enabled": true,
            "minChars": 20,
            "maxChars": 600,
            "maxConversationTurns": 4,
            "dedupeThreshold": 0.8,
            "candidateQueue": {
              "enabled": true,
              "intervalMs": 10000,
              "maxBatchSize": 50
            }
          },

          // =====================
          // 异步写回队列
          // =====================
          "outbox": {
            "enabled": true,
            "concurrency": 2,
            "batchSize": 10,
            "maxRetries": 5,
            "drainTimeoutMs": 5000,
            "flushIntervalMs": 10000
          },

          // =====================
          // Markdown 同步
          // =====================
          "sync": {
            "enabled": true,
            "intervalMs": 300000,
            "memoryFilePath": "MEMORY.md"
          },

          // =====================
          // 意图分类器
          // =====================
          "classifier": {
            "enabled": true,
            "model": "gemini-2.0-flash-lite"
          }
        }
      }
    },
    "slots": {
      "memory": "memory-mem0"
    }
  }
}
```

### 4.3 使用 Ollama 作为 LLM（无需 API Key）

如果希望完全本地化运行，可以使用 Ollama 作为 LLM：

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
  }
}
```

需要先下载 LLM 模型：

```bash
ollama pull qwen2.5:7b
# 或
ollama pull llama3.2:latest
```

---

## 5. 验证安装

### 5.1 检查后端服务

```bash
# 检查所有服务状态
echo "=== Docker Containers ==="
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "qdrant|neo4j"

echo "\n=== Ollama ==="
ollama list

echo "\n=== Qdrant API ==="
curl -s http://localhost:6333/collections | head -c 100

echo "\n=== Neo4j (if enabled) ==="
curl -s http://localhost:7474 | head -c 100
```

### 5.2 重启 OpenClaw

```bash
# 重启 gateway 加载新配置
openclaw gateway restart

# 或完全重启
openclaw stop && openclaw start
```

### 5.3 检查插件状态

```bash
# 列出已加载插件
openclaw plugins list

# 查看 memory-mem0 状态
/memu status
```

预期输出：

```
memU Memory Status
══════════════════

Backend:
  Provider:      mem0 (open-source)
  Status:        Online

Scope:
  User ID:       your-user-id
  Agent ID:      main

Core Memory:
  Items:         0
  Always-Inject: profile, general

Cache:
  Size:          0 / 100
  Hit Rate:      0.0%

Outbox:
  Pending:       0
  Sent:          0
  Dead Letters:  0
```

### 5.4 测试记忆功能

```bash
# 存储测试记忆
openclaw agent --agent main --message "记住我叫张三，我是后端工程师，喜欢用 Go 语言"

# 等待几秒让捕获生效...

# 召回测试
openclaw agent --agent main --message "我叫什么名字？"
openclaw agent --agent main --message "我的技术栈是什么？"
```

---

## 6. 配置参考

### 6.1 Embedding 模型对照表

| Provider | 模型 | 维度 | 说明 |
|----------|------|------|------|
| `ollama` | `bge-m3:latest` | 1024 | 中文优化，推荐 |
| `ollama` | `nomic-embed-text:latest` | 768 | 轻量通用 |
| `ollama` | `mxbai-embed-large:latest` | 1024 | 高质量通用 |
| `openai` | `text-embedding-3-small` | 1536 | OpenAI 官方 |

### 6.2 LLM 模型对照表

| Provider | 模型 | 用途 |
|----------|------|------|
| `google` | `gemini-2.5-flash` | 快速处理，推荐 |
| `google` | `gemini-2.5-pro` | 高质量处理 |
| `ollama` | `qwen2.5:7b` | 本地中文 |
| `ollama` | `llama3.2:latest` | 本地通用 |
| `openai` | `gpt-4o-mini` | OpenAI 快速 |

### 6.3 向量数据库支持

| Provider | 端口 | 说明 |
|----------|------|------|
| `qdrant` | 6333 | 推荐，高性能 |
| `chroma` | 8000 | 轻量替代 |
| `pgvector` | 5432 | PostgreSQL 扩展 |

### 6.4 端口速查

| 服务 | 端口 | 用途 |
|------|------|------|
| Qdrant REST | 6333 | 向量检索 API |
| Qdrant gRPC | 6334 | 高性能接口 |
| Ollama | 11434 | Embedding/LLM |
| Neo4j HTTP | 7474 | Browser UI |
| Neo4j Bolt | 7687 | 数据库连接 |

---

## 7. 故障排查

### 7.1 常见错误

| 错误 | 原因 | 解决方案 |
|------|------|----------|
| `Connection refused :6333` | Qdrant 未启动 | `docker start qdrant` |
| `Connection refused :11434` | Ollama 未启动 | `ollama serve` 或 `brew services start ollama` |
| `unable to open database file` | historyDbPath 路径无效 | 确保 `dataDir` 目录存在且有写权限 |
| `401 Incorrect API key` (Graph) | Graph 路径落到了 mem0 默认 OpenAI 配置 | 优先检查插件是否为最新版；若需手动覆盖，改成 `provider=openai` 并设置 Google OpenAI-compatible `baseURL` |
| `dimension mismatch` | Embedding 维度不匹配 | 检查 `embeddingDims` 与模型一致 |
| `plugin id mismatch` | 插件名不匹配 | 在 openclaw.json 的 installs 中添加 `resolvedName` |

### 7.2 检查命令

```bash
# 检查 Qdrant 集合
curl http://localhost:6333/collections

# 检查 Ollama 模型
ollama list

# 检查 Neo4j 连接
curl -u neo4j:your-password http://localhost:7474/db/neo4j/tx

# 检查插件日志
tail -f ~/.openclaw/logs/gateway.log | grep memory-mem0

# 手动测试 Embedding
curl http://localhost:11434/api/embeddings -d '{"model":"bge-m3","prompt":"test"}'
```

### 7.3 重置数据

```bash
# 清除所有记忆数据（谨慎操作）
rm -rf ~/.openclaw/data/memory-mem0/*

# 重置 Qdrant 集合
docker exec qdrant curl -X DELETE http://localhost:6333/collections/mem0

# 重置 Neo4j 数据
docker exec neo4j cypher-shell -u neo4j -p your-password "MATCH (n) DETACH DELETE n"
```

---

## 8. 一键安装脚本

将以下脚本保存为 `install-mem0-stack.sh` 并执行：

```bash
#!/bin/bash
set -e

echo "=== Installing mem0 backend stack ==="

# 1. 检查 Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Please install Docker first."
    exit 1
fi

# 2. 检查 Ollama
if ! command -v ollama &> /dev/null; then
    echo "📦 Installing Ollama..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install ollama
    else
        curl -fsSL https://ollama.com/install.sh | sh
    fi
fi

# 3. 启动 Qdrant
echo "🚀 Starting Qdrant..."
docker rm -f qdrant 2>/dev/null || true
mkdir -p ~/.qdrant/storage
docker run -d \
  --name qdrant \
  --restart unless-stopped \
  -p 6333:6333 \
  -p 6334:6334 \
  -v ~/.qdrant/storage:/qdrant/storage \
  qdrant/qdrant:v1.13.6

# 4. 启动 Neo4j（可选）
read -p "Install Neo4j for Graph Memory? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🚀 Starting Neo4j..."
    docker rm -f neo4j 2>/dev/null || true
    mkdir -p ~/.neo4j/data ~/.neo4j/logs
    docker run -d \
      --name neo4j \
      --restart unless-stopped \
      -p 7474:7474 \
      -p 7687:7687 \
      -v ~/.neo4j/data:/data \
      -v ~/.neo4j/logs:/logs \
      -e NEO4J_AUTH=neo4j/password \
      -e NEO4J_PLUGINS='["apoc"]' \
      neo4j:latest
fi

# 5. 启动 Ollama 并下载模型
echo "🚀 Starting Ollama..."
ollama serve &>/dev/null &
sleep 2

echo "📥 Pulling bge-m3 embedding model..."
ollama pull bge-m3:latest

# 6. 安装插件
echo "📦 Installing memory-mem0 plugin..."
mkdir -p ~/.openclaw/extensions
cd ~/.openclaw/extensions
if [ -d "memory-mem0" ]; then
    cd memory-mem0 && git pull && npm install
else
    git clone https://github.com/BreakDimbo/mem0-plugin-for-openclaw.git memory-mem0
    cd memory-mem0 && npm install
fi

# 7. 创建数据目录
mkdir -p ~/.openclaw/data/memory-mem0

echo ""
echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "1. Add your Gemini API key to ~/.openclaw/openclaw.json"
echo "2. Configure the memory-mem0 plugin (see INSTALL.md)"
echo "3. Restart OpenClaw: openclaw gateway restart"
echo ""
echo "Service status:"
docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "qdrant|neo4j" || echo "  (check docker ps)"
ollama list 2>/dev/null || echo "  (check ollama list)"
```

**使用方法：**

```bash
chmod +x install-mem0-stack.sh
./install-mem0-stack.sh
```

---

## 参考资料

- [mem0 GitHub](https://github.com/mem0ai/mem0)
- [mem0 文档](https://docs.mem0.ai)
- [Qdrant 文档](https://qdrant.tech/documentation/)
- [Ollama 文档](https://ollama.com)
- [Neo4j 文档](https://neo4j.com/docs/)

---

> 文档版本 v1.1.1 · 2026-03-17
