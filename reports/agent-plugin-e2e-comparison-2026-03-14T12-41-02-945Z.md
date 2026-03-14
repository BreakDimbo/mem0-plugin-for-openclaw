# Agent End-to-End Memory Plugin Comparison

- Generated at: 2026-03-14T12:54:04.945Z
- Method: Real openclaw agent end-to-end benchmark on turning_zero. Each plugin variant runs all 40 cases in the same session; /new is issued only once when switching plugin variants. Auto-capture is disabled during the benchmark to keep the memory corpus frozen while switching only the memory plugin.
- Raw report: [agent-plugin-e2e-comparison](~/.openclaw/extensions/memory-mem0/reports/agent-plugin-e2e-comparison-2026-03-14T12-41-02-945Z.json)

## Summary

| Metric | current plugin | official mem0 plugin |
|---|---:|---:|
| Hits (40 cases) | 34/40 | 34/40 |
| Hit rate | 85.0% | 85.0% |
| Avg duration | 9944 ms | 7606 ms |
| P95 duration | 20036 ms | 10703 ms |

## Current Plugin Only Hits

- `e2e-08` 用户当前的全职工作是什么？ -> expected `某互联网公司程序员`, answer `某互联网公司程序员`
- `e2e-15` 用户偏好的表达方式是什么？ -> expected `金字塔`, answer `金字塔原理：结论先行，核心论点前置，细节随后`
- `e2e-20` turning_zero 在缺乏数据时应该怎么做？ -> expected `调用工具检索`, answer `调用工具检索`
- `e2e-33` memU-server 优化后的月费用大概是多少？ -> expected `0 美元`, answer `0 美元`
- `e2e-39` 目标记忆架构的第3层是什么？ -> expected `Core Memory K/V`, answer `Core Memory K/V`

## Official Plugin Only Hits

- `e2e-25` smart-router 分类器现在是什么模型？ -> expected `gemini-3.1-flash-lite-preview`, answer `gemini-3.1-flash-lite-preview`
- `e2e-26` memU retrieve 优化时 route_intention 是什么状态？ -> expected `关闭`, answer `关闭。`
- `e2e-32` memU-server 优化后 retrieve 的 P95 延迟是多少？ -> expected `120ms`, answer `120ms`
- `e2e-34` memory-memu 把 retrieve 超时调整到了多少？ -> expected `5000ms`, answer `5000ms`
- `e2e-36` 目标记忆架构一共有几层？ -> expected `四层`, answer `四层`

## Both Miss

- `e2e-14` 用户偏好的沟通风格是什么？ -> expected `平静、专业、直击要害`, current answer `直击要害，厌恶废话`

## Conclusion

在真实 turning_zero agent 场景下，两套插件的端到端回答命中率相同。

