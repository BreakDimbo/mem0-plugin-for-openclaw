# memory-memu 插件安装与配置指南

## 1. 前置依赖

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| OpenClaw | 最新稳定版 | 需支持 `kind: "memory"` 插件 |
| Node.js | >= 18 | TypeScript 插件运行时 |
| memU Server | 最新版 | 长期记忆 REST API 服务 |
| PostgreSQL | >= 14 + pgvector | memU 存储后端 |

**所需 API Key：**

| Key | 用途 | 是否必须 |
|-----|------|---------|
| Moonshot API Key | memU 记忆提取 LLM（或其他兼容 LLM） | 是 |
| Embedding API Key | memU 向量编码 | 是 |

---

## 2. 安装插件

将 `memory-memu` 目录复制到 OpenClaw 扩展目录：

```bash
cp -r memory-memu ~/.openclaw/extensions/memory-memu
```

验证插件目录结构：

```bash
ls ~/.openclaw/extensions/memory-memu/
# 应包含: index.ts, types.ts, client.ts, adapter.ts, cache.ts,
#         outbox.ts, security.ts, metrics.ts, sync.ts, cli.ts,
#         openclaw.plugin.json, package.json, tsconfig.json,
#         hooks/, tools/, tests/
```

---

## 3. 启动 memU Server

```bash
cd /path/to/memU-server
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

验证 memU Server 运行状态：

```bash
curl http://127.0.0.1:8000/debug
# 应返回 200 OK
```

验证 PostgreSQL + pgvector：

```bash
psql -h localhost -U postgres -c "SELECT * FROM pg_extension WHERE extname = 'vector';"
```

---

## 4. 配置 OpenClaw

在 OpenClaw 配置文件中添加插件配置：

```json
{
  "plugins": {
    "entries": {
      "memory-memu": {
        "enabled": true,
        "config": {
          "memu": {
            "baseUrl": "http://127.0.0.1:8000",
            "timeoutMs": 5000,
            "cbResetMs": 10000,
            "healthCheckPath": "/debug"
          },
          "scope": {
            "userId": "your_user_id",
            "userIdByAgent": {
              "main": "your_user_id"
            },
            "requireUserId": true,
            "requireAgentId": true
          },
          "recall": {
            "enabled": true,
            "method": "rag",
            "topK": 3,
            "scoreThreshold": 0.30,
            "maxContextChars": 1200,
            "cacheTtlMs": 60000,
            "cacheMaxSize": 100
          },
          "capture": {
            "enabled": true,
            "maxItemsPerRun": 3,
            "minChars": 10,
            "maxChars": 500,
            "dedupeThreshold": 0.95
          },
          "outbox": {
            "enabled": true,
            "concurrency": 2,
            "batchSize": 10,
            "maxRetries": 5,
            "drainTimeoutMs": 5000
          },
          "sync": {
            "flushToMarkdown": true,
            "flushIntervalSec": 300,
            "memoryFilePath": "MEMORY.md"
          }
        }
      }
    },
    "slots": {
      "memory": "memory-memu"
    }
  }
}
```

> **注意：** `scope.agentId` 无需配置。插件运行时会优先从 OpenClaw 上下文获取当前 agent 的 `agentId`、`sessionKey`、`workspaceDir`，实现按 `userId + agentId` 隔离，并将 `MEMORY.md` 写回到对应 workspace。配置中的 `agentId` 仅作为 fallback。

---

## 5. 验证安装

```bash
# 查看插件是否加载
openclaw plugins list

# 查看 memU 连接状态
openclaw memu status
```

预期输出：

```
memU Memory Status
══════════════════

Connection:
  Server:          http://127.0.0.1:8000
  Status:          Online
  Circuit Breaker: closed (failures: 0)

Scope:
  User ID:  your_user_id
  Agent ID: main

Cache:
  Size:     0 / 100
  Hit Rate: 0.0%

Outbox:
  Pending:      0
  Sent:         0
  Failed:       0
  Dead Letters: 0

Sync:
  Enabled:  true
  Syncs:    0
  Written:  0
  Last:     never
```

---

## 6. 配置项速查

### memu — 服务连接

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `baseUrl` | string | `http://127.0.0.1:8000` | memU Server 地址 |
| `timeoutMs` | number | `5000` | 请求超时（500-30000） |
| `cbResetMs` | number | `10000` | Circuit Breaker 从 open 到 half-open 的重试窗口（1000-120000） |
| `healthCheckPath` | string | `/debug` | 健康检查路径 |

### scope — 作用域隔离

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `userId` | string | `default_user` | 用户标识 |
| `userIdByAgent` | object | — | 可选的 `agentId -> userId` 映射，多 agent 场景建议配置 |
| `agentId` | string | `main` | Agent 标识（fallback 默认值，运行时自动从 `ctx.agentId` 获取） |
| `tenantId` | string | — | 租户标识（可选） |
| `requireUserId` | boolean | `true` | 是否强制要求 userId |
| `requireAgentId` | boolean | `true` | 是否强制要求 agentId |

> **多 Agent 说明：** 插件的真实隔离边界是 `userId + agentId`。如果不同 agent 对应不同用户，请通过 `scope.userIdByAgent` 明确配置映射；否则会回退到全局 `scope.userId`。

### recall — 自动召回

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 启用自动召回注入 |
| `method` | string | `rag` | 检索方式：`rag` 或 `llm` |
| `topK` | number | `3` | 最大召回条数（1-20） |
| `scoreThreshold` | number | `0.30` | 最低相关性分数（0-1） |
| `maxContextChars` | number | `1200` | 注入上下文最大字符数（200-5000） |
| `cacheTtlMs` | number | `60000` | 缓存 TTL（0-600000） |
| `cacheMaxSize` | number | `100` | 缓存最大条目数 |

### capture — 自动捕获

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 启用自动捕获 |
| `maxItemsPerRun` | number | `3` | 每轮最大捕获条数（1-10） |
| `minChars` | number | `10` | 最小文本长度 |
| `maxChars` | number | `500` | 最大文本长度 |
| `dedupeThreshold` | number | `0.95` | 去重相似度阈值 |

### outbox — 异步写回队列

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 启用 outbox |
| `concurrency` | number | `2` | 并发发送数 |
| `batchSize` | number | `10` | 每批最大提交数 |
| `maxRetries` | number | `5` | 最大重试次数（超过转 dead-letter） |
| `drainTimeoutMs` | number | `5000` | 退出时 drain 超时 |
| `persistPath` | string | `~/.openclaw/data/memory-memu` | 队列持久化目录 |
| `flushIntervalMs` | number | `10000` | flush 间隔（ms） |

### sync — Markdown 回写

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `flushToMarkdown` | boolean | `true` | 启用定期回写 MEMORY.md |
| `flushIntervalSec` | number | `300` | 回写间隔（秒） |
| `memoryFilePath` | string | — | MEMORY.md 路径，支持绝对路径或相对路径 |

#### 多 Agent 的 memoryFilePath 配置

每个 agent 有独立的 `workspaceDir`（由 OpenClaw 运行时注入），`memoryFilePath` 配置为**相对路径**时会自动解析到各 agent 各自的 workspace 目录下。

**单 Agent**（绝对路径）：

```json
"sync": {
  "memoryFilePath": "/path/to/workspace/MEMORY.md"
}
```

所有记忆写入同一个固定文件。

**多 Agent**（相对路径，推荐）：

```json
"sync": {
  "memoryFilePath": "MEMORY.md"
}
```

插件在每个 agent 首次触发 hook 时，自动从 `ctx.workspaceDir` 获取该 agent 的工作目录并注册。sync 定时器触发时，会为每个已注册的 agent 分别写入：

- `code-review` agent (workspace: `/project/agents/code-review/`) → `/project/agents/code-review/MEMORY.md`
- `qa-tester` agent (workspace: `/project/agents/qa-tester/`) → `/project/agents/qa-tester/MEMORY.md`
- `main` agent (workspace: `/project/agents/main/`) → `/project/agents/main/MEMORY.md`

也支持子目录形式的相对路径：

```json
"sync": {
  "memoryFilePath": ".claude/MEMORY.md"
}
```

目录不存在时会自动创建。无需手动枚举 agent 列表。

---

## 7. Agent 工具

安装后 Agent 可使用以下工具：

| 工具 | 说明 | 参数 |
|------|------|------|
| `memory_recall` | 检索长期记忆 | `query`（必填）, `limit`, `category` |
| `memory_store` | 存储一条持久事实 | `content`（必填）, `context` |
| `memory_forget` | 删除记忆 | `confirm`（必填）, `memoryId`, `query` |
| `memory_stats` | 查看运行状态 | 无 |

---

## 8. CLI 命令

| 命令 | 说明 |
|------|------|
| `/memu status` | 查看连接状态、scope、缓存、队列 |
| `/memu search <query>` | 手动检索记忆 |
| `/memu flush` | 手动清空 outbox 队列 |
| `/memu dashboard` | 查看完整 metrics 仪表盘 |
| `/memu audit [limit]` | 查看审计日志（默认 20 条） |

---

## 9. 最小化配置（快速开始）

只需配置 `baseUrl` 和 `userId`，其余使用默认值：

```json
{
  "plugins": {
    "entries": {
      "memory-memu": {
        "enabled": true,
        "config": {
          "memu": {
            "baseUrl": "http://127.0.0.1:8000"
          },
          "scope": {
            "userId": "your_user_id"
          }
        }
      }
    },
    "slots": {
      "memory": "memory-memu"
    }
  }
}
```

---

## 10. 故障排查

| 问题 | 检查方式 | 解决 |
|------|---------|------|
| Status 显示 OFFLINE | `curl http://127.0.0.1:8000/debug` | 确认 memU Server 已启动 |
| Circuit Breaker 为 open | `/memu status` 查看 failures | 检查 memU Server 日志，等待 30s 自动恢复 |
| Outbox 持续积压 | `/memu dashboard` 查看 pending | `curl` 测试 `/memorize` 接口；检查 memU Server 负载 |
| 召回结果为空 | `/memu search "测试查询"` | 先用 `memory_store` 存入测试数据 |
| 记忆未自动捕获 | `/memu dashboard` 查看 capture filtered | 检查消息是否满足 minChars/maxChars，是否命中敏感词过滤 |
| Markdown 未同步 | `/memu status` 查看 Sync | 确认 `sync.memoryFilePath` 已配置 |

---

## 11. 运行合约测试

```bash
# 确保 memU Server 正在运行
cd ~/.openclaw/extensions/memory-memu
npx tsx tests/contract.test.ts

# 运行单元测试
npx tsx tests/cache.test.ts
npx tsx tests/security.test.ts
npx tsx tests/outbox.test.ts
```
