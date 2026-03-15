# @openclaw/memory-mem0

**OpenClaw 双层长期记忆插件** — 本地 Core Memory + 远程自由文本向量检索（基于 [mem0](https://github.com/mem0ai/mem0)）。

在 prompt 构建前自动召回相关记忆，在对话结束后自动捕获持久性事实。中文优先设计，内置 CJK 分词、中文数字归一化和语义重排序。

## 项目亮点

- **双层记忆架构** — 结构化 Core Memory（本地 JSON K/V）存放高置信度事实 + 自由文本向量记忆（mem0）覆盖长尾知识。Core Memory 始终注入上下文，自由文本按需检索。
- **端到端召回率 78.6%** — 在覆盖用户画像、目标、偏好、约束、技术配置和架构决策的 70 条基准测试中，显著超越官方 mem0 插件的 35.7%。
- **LLM 准入门控** — 可选的 Gemini 驱动质量过滤器，将候选记忆分类为 `core`（核心）/ `free_text`（自由文本）/ `discard`（丢弃），从源头消除噪声。
- **异步捕获流水线** — `CandidateQueue → LLM Gate → Outbox → mem0`，具备哈希去重、批量处理、指数退避重试和磁盘持久化。对 Agent 响应延迟零影响。
- **中文优先** — CJK bigram 分词、中文数字归一化（第一 ↔ 1）、跨语言语义匹配。
- **多 Agent / 多租户** — 通过 `userId + agentId + sessionKey + tenantId` 实现完整作用域隔离。支持按 Agent 映射 userId。
- **9 个 Agent 工具** — `memory_recall`、`memory_store`、`memory_forget`、`memory_stats`、`memory_core_list`、`memory_core_upsert`、`memory_core_delete`、`memory_core_touch`、`memory_core_proposals`。
- **CLI 仪表盘** — `/memu status`、`/memu search`、`/memu flush`、`/memu dashboard`、`/memu audit`。

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw Agent                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  before_prompt_build          agent_end / message_recv  │
│         │                            │                  │
│         ▼                            ▼                  │
│  ┌─────────────┐            ┌────────────────┐          │
│  │  召回 Hook  │            │  捕获 Hook     │          │
│  │             │            │                │          │
│  │ 1. 提取查询 │            │ 1. 过滤        │          │
│  │ 2. 双层检索 │            │   (低信号/注入) │          │
│  │ 3. 语义重排 │            │ 2. 去重        │          │
│  │ 4. 会话去重 │            │ 3. 入队        │          │
│  │ 5. 注入上下  │            └───────┬────────┘          │
│  │    文       │                    │                   │
│  └─────────────┘                    ▼                   │
│         │                   ┌────────────────┐          │
│         ▼                   │ CandidateQueue │          │
│  ┌─────────────┐            │  (批量定时器)   │          │
│  │  上下文注入  │            └───────┬────────┘          │
│  │             │                    │                   │
│  │ <core-      │                    ▼                   │
│  │  memory>    │            ┌────────────────┐          │
│  │ <relevant-  │            │  LLM 准入门控   │          │
│  │  memories>  │            │  (Gemini)      │          │
│  └─────────────┘            │                │          │
│                             │ core/free_text │          │
│                             │ /discard       │          │
│                             └──┬─────────┬───┘          │
│                                │         │              │
│                   ┌────────────┘         └──────┐       │
│                   ▼                             ▼       │
│           ┌──────────────┐            ┌──────────────┐  │
│           │ Core Memory  │            │   Outbox     │  │
│           │ (本地 JSON)   │            │ (异步队列    │  │
│           │              │            │  重试/批量)   │  │
│           │ profile 层   │            └──────┬───────┘  │
│           │ technical 层 │                   │          │
│           │ general 层   │                   ▼          │
│           └──────────────┘            ┌──────────────┐  │
│                                       │  mem0 API    │  │
│                                       │ (向量数据库)  │  │
│                                       └──────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 记忆分层

| 层级 | 存储位置 | 注入方式 | 适用场景 |
|------|---------|---------|---------|
| **profile** | Core Memory（本地） | 始终注入 | 身份、偏好、目标、关系 |
| **technical** | Core Memory（本地） | 按需检索 | 技术配置、架构、决策 |
| **general** | Core Memory（本地） | 始终注入 | 其他高置信度事实 |
| **free-text** | mem0（远程） | 按需召回 | 长尾知识、经验教训 |

## 基准测试：对比官方 mem0 插件

70 条端到端召回基准测试。相同的记忆语料、相同的查询、相同的 LLM。

| 指标 | memory-mem0（本插件） | @mem0/openclaw-mem0（官方） |
|------|---:|---:|
| **召回命中率** | **78.6%**（55/70） | 35.7%（25/70） |
| 平均响应时间 | 12.6s | 24.5s |
| P95 响应时间 | 14.8s | 31.2s |

### 差异根因分析

| 维度 | 本插件 | 官方插件 |
|------|--------|---------|
| Core Memory | 本地 JSON + 分层注入 | 无（仅自由文本） |
| 查询理解 | 分词 + 语义重排 + 中文数字归一化 | 原始向量搜索 |
| 结构化事实 | 正则提取 + LLM 门控写入 K/V | 依赖 mem0 的 add 改写 |
| 会话去重 | 按会话跟踪已注入记忆 | 无 |
| 上下文预算 | 按优先级控制注入量 | 无排序平铺注入 |

### 分类命中率

| 类别 | 用例数 | 命中率 |
|------|------:|------:|
| 用户画像（姓名、城市、职业、MBTI） | 10 | 100% |
| 目标（职业、健康、兴趣） | 8 | 87.5% |
| 偏好（沟通方式、工具） | 12 | 91.7% |
| 约束（隐私、删除规则） | 7 | 85.7% |
| 技术配置（模型、延迟） | 14 | 57.1% |
| 架构设计（四层架构） | 9 | 55.6% |
| 跨类别 / 复合查询 | 4 | 75.0% |
| 改述 / 对话式查询 | 6 | 83.3% |

> 技术和架构类事实命中率较低，原因是 mem0 的 `add` API 在存储时会改写内容（翻译为英文、丢失 "120ms"、"3072" 等数值精度）。这是 mem0 后端的局限，而非召回层的问题。

### 召回率演进

| 版本 | 命中率 | 关键变更 |
|------|------:|---------|
| 基线（官方插件） | 35.7% | 仅自由文本，无 Core Memory |
| + Core Memory + 语义重排 | 75.7% | 本地 K/V 存储、语义重排序 |
| + 捕获流水线修复 | 78.6% | CLI 模式捕获、LLM 门控、去重修复 |
| + 预填充语料（上界） | 92.9% | 所有事实预存储 |

## 快速开始

### 1. 安装

```bash
cp -r memory-mem0 ~/.openclaw/extensions/memory-mem0
cd ~/.openclaw/extensions/memory-mem0 && npm install
```

### 2. 配置

在 `~/.openclaw/openclaw.json` 中添加：

```jsonc
{
  "plugins": {
    "entries": {
      "memory-mem0": {
        "enabled": true,
        "config": {
          "mem0": {
            "mode": "open-source",                    // 或 "platform"
            "oss": {
              "llm": {
                "provider": "google",
                "config": { "apiKey": "YOUR_KEY", "model": "gemini-2.5-flash" }
              },
              "embedder": {
                "provider": "ollama",
                "config": { "model": "nomic-embed-text" }
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

### 3. 验证

```bash
openclaw gateway restart
openclaw agent --agent main --message "记住我叫张三，我是后端工程师"
openclaw agent --agent main --message "我叫什么名字？"
```

完整配置参考请查看 [INSTALL.md](./INSTALL.md)。

## 项目结构

```
├── index.ts                  # 插件入口，生命周期管理
├── hooks/
│   ├── recall.ts             # before_prompt_build — 检索 + 注入
│   ├── capture.ts            # agent_end — 提取 + 入队
│   └── message-received.ts   # 逐条消息跟踪
├── tools/                    # 9 个 Agent 工具（recall, store, forget 等）
├── backends/free-text/
│   ├── base.ts               # FreeTextBackend 接口
│   ├── factory.ts            # 提供者工厂
│   └── mem0.ts               # mem0 平台版 + 开源版实现
├── core-repository.ts        # 本地 Core Memory K/V 存储
├── core-admission.ts         # LLM 准入门控（Gemini 分类器）
├── core-proposals.ts         # 正则提取 + 人工审核队列
├── candidate-queue.ts        # 批量捕获队列（哈希去重）
├── outbox.ts                 # 异步写入队列（重试/退避）
├── cache.ts                  # LRU 缓存（带 TTL）
├── metadata.ts               # 分词、中文数字归一化、排序
├── security.ts               # 注入检测、XML 转义
├── sync.ts                   # Markdown 导出到工作区
├── metrics.ts                # 运行时遥测
├── cli.ts                    # /memu CLI 命令
├── types.ts                  # 配置 Schema + 默认值
├── scripts/                  # 基准测试、数据回填、对比工具
└── tests/                    # 20 个测试文件，63+ 端到端生命周期用例
```

## 运行测试

```bash
# 单元测试
npx tsx tests/cache.test.ts
npx tsx tests/core-repository.test.ts
npx tsx tests/metadata.test.ts
npx tsx tests/security.test.ts

# 集成测试
npx tsx tests/e2e-lifecycle.test.ts          # 63 个用例
npx tsx tests/capture-fallback.test.ts       # 12 个用例

# 基准测试
npx tsx scripts/run-e2e-ingest-and-benchmark.ts         # 完整端到端流水线
npx tsx scripts/run-plugin-recall-comparison.ts          # 对比官方插件
npx tsx scripts/run-agent-plugin-e2e-comparison.ts       # Agent 级别对比
```

## 核心设计决策

1. **Core Memory 存储在本地而非远程** — 结构化事实存储在本地 JSON 文件中，为高置信度信息提供确定性、零延迟召回。查询"用户叫什么名字"不依赖任何网络请求。

2. **捕获是异步且尽力而为的** — `CandidateQueue → Outbox` 流水线永远不会阻塞 Agent 响应。失败的捕获会被丢弃（而非无限重试），因为后续新消息会重新捕获相同的事实。

3. **LLM 门控是可选的** — 正则模式可捕获约 60% 的核心事实（身份、偏好、目标）。LLM 门控负责剩余 40%（技术配置、架构决策）。两条路径可独立工作。

4. **中文优先的分词设计** — CJK 文本没有天然的词边界。metadata 层使用 bigram 分词和中文数字归一化来实现精确的语义匹配。

5. **会话级去重** — 防止在同一对话中重复注入相同记忆，保持上下文预算精简。

## 依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| `mem0ai` | ^2.3.0 | 自由文本向量记忆后端 |
| OpenClaw SDK | peer | 插件宿主运行时 |

## License

MIT
