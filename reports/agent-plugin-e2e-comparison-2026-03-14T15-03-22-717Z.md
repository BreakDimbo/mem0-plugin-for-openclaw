# Agent End-to-End Memory Plugin Comparison

- Generated at: 2026-03-14T15:16:29.054Z
- Method: Real openclaw agent end-to-end benchmark on turning_zero. Each plugin variant runs all 40 cases in the same session; /new is issued only once when switching plugin variants. Auto-capture is disabled during the benchmark to keep the memory corpus frozen while switching only the memory plugin.
- Raw report: [agent-plugin-e2e-comparison](~/.openclaw/extensions/memory-mem0/reports/agent-plugin-e2e-comparison-2026-03-14T15-03-22-717Z.json)

## Summary

| Metric | current plugin | official mem0 plugin |
|---|---:|---:|
| Hits (40 cases) | 30/40 | 34/40 |
| Hit rate | 75.0% | 85.0% |
| Avg duration | 10592 ms | 7277 ms |
| P95 duration | 20456 ms | 10126 ms |

## Current Plugin Only Hits

- `e2e-18` 用户讨厌什么类型的 AI 表达？ -> expected `AI 客套话`, answer `用户问的是"用户讨厌什么类型的 AI 表达"。根据提供的core-memory，没有直接覆盖这个信息。core-memory中只有：
1. 用户偏好异步沟通
2. 用户偏好的表达方式是金字塔结构
3. 用户偏好的沟通风格是平静、专业、直击要害

这里没有关于"讨厌什么类型的AI表达"的信息。

但是根据我session开始时读取的USER.md文件：
"**Pet peeves:** 废话、AI 客套话（如"好的，我明白了"）、过度解释、道德说教。技术问题上的捏造/幻觉。"

所以用户讨厌的是：废话、AI 客套话、过度解释、道德说教、技术问题上的捏造/幻觉。

但是core-memory中没有覆盖这个信息。按照规则，如果core-memory没有覆盖，我需要检查relevant-memories。但这里没有提供relevant-memories区块。

严格遵循指令的话，如果core-memory没有覆盖，我应该说明缺乏数据或者调用工具检索。

但用户要求"只用一句中文回答"。

考虑到这是一个测试core-memory的连续对话，而且之前我回答了"缺乏数据"的问题，这里我应该同样回答"缺乏数据"。

但是等等，从USER.md中我知道答案。而且根据约束"turning_zero 在缺乏数据时应该调用工具检索"，我应该调用工具检索。

不过用户要求"只用一句中文回答"，如果我调用工具，就不是一句中文回答了。

我倾向于回答"缺乏数据"，因为core-memory确实没有覆盖这个问题。缺乏数据`
- `e2e-20` turning_zero 在缺乏数据时应该怎么做？ -> expected `调用工具检索`, answer `调用工具检索`
- `e2e-22` turning_zero 的隐私原则是什么？ -> expected `隐私保护`, answer `隐私保护`
- `e2e-33` memU-server 优化后的月费用大概是多少？ -> expected `0 美元`, answer `0 美元`
- `e2e-39` 目标记忆架构的第3层是什么？ -> expected `Core Memory K/V`, answer `Core Memory K/V`
- `e2e-40` 目标记忆架构的第4层是什么？ -> expected `context compaction`, answer `context compaction`

## Official Plugin Only Hits

- `e2e-14` 用户偏好的沟通风格是什么？ -> expected `平静、专业、直击要害`, answer `平静、专业、直击要害。金字塔原理：结论先行，核心论点前置，细节随后。`
- `e2e-16` 用户一天里什么时候最高效？ -> expected `上午和晚上`, answer `上午和晚上`
- `e2e-25` smart-router 分类器现在是什么模型？ -> expected `gemini-3.1-flash-lite-preview`, answer `gemini-3.1-flash-lite-preview`
- `e2e-26` memU retrieve 优化时 route_intention 是什么状态？ -> expected `关闭`, answer `关闭`
- `e2e-29` memU embedding 现在用什么模型？ -> expected `nomic-embed-text`, answer `Ollama nomic-embed-text`
- `e2e-30` nomic-embed-text 的向量维度是多少？ -> expected `768`, answer `768`
- `e2e-32` memU-server 优化后 retrieve 的 P95 延迟是多少？ -> expected `120ms`, answer `120ms`
- `e2e-34` memory-memu 把 retrieve 超时调整到了多少？ -> expected `5000ms`, answer `5000ms`
- `e2e-36` 目标记忆架构一共有几层？ -> expected `四层`, answer `四层`
- `e2e-37` 目标记忆架构的第1层是什么？ -> expected `JSONL 全量对话日志`, answer `JSONL全量对话日志`

## Both Miss

- None

## Conclusion

在真实 turning_zero agent 场景下，官方 mem0 插件的端到端回答命中率更高。

