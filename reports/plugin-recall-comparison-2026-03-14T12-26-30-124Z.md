# Memory Plugin Recall Comparison

- Generated at: 2026-03-14T12:27:35.044Z
- Method: Recall-layer comparison using injected context only; model answer variability excluded.
- Current plugin: `memory-mem0`
- Baseline plugin: `@mem0/openclaw-mem0`
- Raw report: [plugin-recall-comparison](~/.openclaw/extensions/memory-mem0/reports/plugin-recall-comparison-2026-03-14T12-26-30-124Z.json)

## Summary

| Metric | memory-mem0 | official mem0 plugin |
|---|---:|---:|
| Recall hits (40 cases) | 39/40 | 18/40 |
| Recall hit rate | 97.5% | 45.0% |
| Avg recall time | 830 ms | 791 ms |
| Avg injected chars | 457 | 176 |

## Difference Breakdown

- Current plugin only hits: 21
- Official plugin only hits: 0
- Both hit: 18
- Both miss: 1

## Current Plugin Only Hits

- `e2e-03` 用户现在的职业是什么？ -> expected `某互联网公司高级后端工程师`
- `e2e-04` 用户主要深耕什么技术领域？ -> expected `分布式系统与高并发`
- `e2e-05` 用户的人格倾向是什么？ -> expected `INTJ`
- `e2e-06` 用户的主目标是什么？ -> expected `一人公司创业者`
- `e2e-08` 用户当前的全职工作是什么？ -> expected `某互联网公司程序员`
- `e2e-12` 用户正在探索哪种开放协作方向？ -> expected `开源项目`
- `e2e-13` 用户最重要的关系对象是谁？ -> expected `爱人`
- `e2e-14` 用户偏好的沟通风格是什么？ -> expected `平静、专业、直击要害`
- `e2e-15` 用户偏好的表达方式是什么？ -> expected `金字塔`
- `e2e-16` 用户一天里什么时候最高效？ -> expected `上午和晚上`
- `e2e-18` 用户讨厌什么类型的 AI 表达？ -> expected `AI 客套话`
- `e2e-20` turning_zero 在缺乏数据时应该怎么做？ -> expected `调用工具检索`
- `e2e-21` turning_zero 遵循什么思考方法？ -> expected `第一性原理`
- `e2e-22` turning_zero 的隐私原则是什么？ -> expected `隐私保护`
- `e2e-23` turning_zero 对删除操作的默认要求是什么？ -> expected `trash`
- `e2e-33` memU-server 优化后的月费用大概是多少？ -> expected `0 美元`
- `e2e-35` memory-memu 的 cbResetMs 配置是多少？ -> expected `10000ms`
- `e2e-36` 目标记忆架构一共有几层？ -> expected `四层`
- `e2e-37` 目标记忆架构的第1层是什么？ -> expected `JSONL 全量对话日志`
- `e2e-39` 目标记忆架构的第3层是什么？ -> expected `Core Memory K/V`
- `e2e-40` 目标记忆架构的第4层是什么？ -> expected `context compaction`

## Official Plugin Only Hits

- None

## Both Miss

- `e2e-17` 用户偏好什么沟通方式？ -> expected `异步沟通`

## Conclusion

在当前这 40 条测试集上，`memory-mem0` 的 recall 命中率高于官方 mem0 插件，主要优势来自本地 Core Memory、workspace fact 补洞和更细的 query-aware 选择。

