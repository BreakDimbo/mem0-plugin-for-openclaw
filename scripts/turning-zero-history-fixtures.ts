import type { FreeTextMemoryKind } from "../types.js";

export type TurningZeroHistoryFact = {
  id: string;
  text: string;
  memoryKind: FreeTextMemoryKind;
  sourceSession: string;
  sourceLabel: string;
};

export type TurningZeroRecallCase = {
  id: string;
  query: string;
  expected: string;
  memoryKinds?: FreeTextMemoryKind[];
};

export const TURNING_ZERO_HISTORY_FACTS: TurningZeroHistoryFact[] = [
  { id: "tz-001", text: "用户名字叫昊。", memoryKind: "profile", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-002", text: "用户所在时区是 UTC+8。", memoryKind: "profile", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-003", text: "用户是某互联网公司高级后端工程师。", memoryKind: "profile", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-004", text: "用户深耕分布式系统与高并发场景。", memoryKind: "profile", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-005", text: "用户的人格倾向是 INTJ。", memoryKind: "profile", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-006", text: "用户对冗余、低效和无逻辑的堆砌零容忍。", memoryKind: "constraint", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-007", text: "用户的主目标是借助 AI/LLM 完成从资深程序员到一人公司创业者的转型。", memoryKind: "project", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-008", text: "用户的健康目标是养成健身习惯并保持健康体重。", memoryKind: "project", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-009", text: "用户当前的全职工作是某互联网公司程序员。", memoryKind: "profile", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-010", text: "用户正在探索自媒体方向。", memoryKind: "project", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-011", text: "用户正在探索 iOS 开发方向。", memoryKind: "project", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-012", text: "用户正在探索游戏开发方向。", memoryKind: "project", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-013", text: "用户正在探索开源项目开发方向。", memoryKind: "project", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-014", text: "用户最重要的关系对象是伴侣。", memoryKind: "relationship", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-015", text: "用户偏好平静、专业、直击要害的沟通风格。", memoryKind: "preference", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-016", text: "用户偏好结论先行、核心论点前置的金字塔表达。", memoryKind: "preference", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-017", text: "用户上午和晚上最高效。", memoryKind: "schedule", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-018", text: "用户偏好异步沟通。", memoryKind: "preference", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-019", text: "用户讨厌废话和 AI 客套话。", memoryKind: "constraint", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-020", text: "用户讨厌过度解释和道德说教。", memoryKind: "constraint", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-021", text: "用户对技术问题上的捏造或幻觉零容忍。", memoryKind: "constraint", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "USER.md" },
  { id: "tz-022", text: "turning_zero 是用户的数字外脑与首席幕僚。", memoryKind: "profile", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "SOUL.md" },
  { id: "tz-023", text: "turning_zero 强调绝对克制，拒绝废话、AI 客套话和过度解释。", memoryKind: "constraint", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "SOUL.md" },
  { id: "tz-024", text: "turning_zero 面对硬核技术问题必须基于工程事实。", memoryKind: "constraint", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "SOUL.md" },
  { id: "tz-025", text: "turning_zero 在缺乏数据时应明确说需要调用工具检索。", memoryKind: "workflow", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "SOUL.md" },
  { id: "tz-026", text: "turning_zero 遵循第一性原理思考。", memoryKind: "workflow", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "SOUL.md" },
  { id: "tz-027", text: "turning_zero 把隐私保护视为红线，不暴露私有架构代码和敏感配置。", memoryKind: "constraint", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "SOUL.md" },
  { id: "tz-028", text: "turning_zero 要求删除操作先确认，并优先使用 trash。", memoryKind: "constraint", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "SOUL.md" },
  { id: "tz-029", text: "turning_zero 对外部行动、发送、发布和不可逆操作需要确认。", memoryKind: "constraint", sourceSession: "00000000-0000-0000-0000-000000000001", sourceLabel: "SOUL.md" },
  { id: "tz-030", text: "smart-router 分类器已改回 gemini-3.1-flash-lite-preview。", memoryKind: "tooling", sourceSession: "80291633-f601-4101-9b46-f28f767317af", sourceLabel: "2026-03-07 项目日志" },
  { id: "tz-031", text: "memU retrieve 优化时关闭了 route_intention。", memoryKind: "tooling", sourceSession: "80291633-f601-4101-9b46-f28f767317af", sourceLabel: "2026-03-07 项目日志" },
  { id: "tz-032", text: "memU retrieve 优化时关闭了 sufficiency_check。", memoryKind: "tooling", sourceSession: "80291633-f601-4101-9b46-f28f767317af", sourceLabel: "2026-03-07 项目日志" },
  { id: "tz-033", text: "memU retrieve 优化时关闭了 resource 检索。", memoryKind: "tooling", sourceSession: "80291633-f601-4101-9b46-f28f767317af", sourceLabel: "2026-03-07 项目日志" },
  { id: "tz-034", text: "memU embedding 后来切换为本地 Ollama 的 nomic-embed-text。", memoryKind: "tooling", sourceSession: "80291633-f601-4101-9b46-f28f767317af", sourceLabel: "2026-03-07 项目日志" },
  { id: "tz-035", text: "nomic-embed-text 的向量维度是 768。", memoryKind: "tooling", sourceSession: "80291633-f601-4101-9b46-f28f767317af", sourceLabel: "2026-03-07 项目日志" },
  { id: "tz-036", text: "Gemini embedding-001 的向量维度是 3072。", memoryKind: "tooling", sourceSession: "80291633-f601-4101-9b46-f28f767317af", sourceLabel: "2026-03-07 项目日志" },
  { id: "tz-037", text: "memU-server 优化后 retrieve 的 P95 延迟达到 120ms。", memoryKind: "tooling", sourceSession: "80291633-f601-4101-9b46-f28f767317af", sourceLabel: "2026-03-07 项目日志" },
  { id: "tz-038", text: "memU-server 优化后的月费用接近 0 美元。", memoryKind: "project", sourceSession: "80291633-f601-4101-9b46-f28f767317af", sourceLabel: "2026-03-07 项目日志" },
  { id: "tz-039", text: "memory-memu 曾把 retrieve 超时从 1500ms 调到 5000ms。", memoryKind: "tooling", sourceSession: "80291633-f601-4101-9b46-f28f767317af", sourceLabel: "2026-03-07 项目日志" },
  { id: "tz-040", text: "memory-memu 新增了 cbResetMs=10000ms 的 circuit breaker 配置。", memoryKind: "tooling", sourceSession: "80291633-f601-4101-9b46-f28f767317af", sourceLabel: "2026-03-07 项目日志" },
  { id: "tz-041", text: "memory-memu 修复过 Agent ID 识别问题。", memoryKind: "workflow", sourceSession: "80291633-f601-4101-9b46-f28f767317af", sourceLabel: "2026-03-07 项目日志" },
  { id: "tz-042", text: "当前记忆体系建议先稳定 recall 链路，再做 Core Memory K/V。", memoryKind: "workflow", sourceSession: "25170f2c-01b4-4eae-a1f2-ccafa77e3e62", sourceLabel: "记忆系统 DIFF 报告" },
  { id: "tz-043", text: "目标记忆架构分为四层。", memoryKind: "workflow", sourceSession: "25170f2c-01b4-4eae-a1f2-ccafa77e3e62", sourceLabel: "记忆系统 DIFF 报告" },
  { id: "tz-044", text: "第 1 层是 JSONL 全量对话日志，用于审计和回放。", memoryKind: "workflow", sourceSession: "25170f2c-01b4-4eae-a1f2-ccafa77e3e62", sourceLabel: "记忆系统 DIFF 报告" },
  { id: "tz-045", text: "第 2 层是可搜索的长期记忆。", memoryKind: "workflow", sourceSession: "25170f2c-01b4-4eae-a1f2-ccafa77e3e62", sourceLabel: "记忆系统 DIFF 报告" },
  { id: "tz-046", text: "第 3 层是支持 importance 和 replace 语义的 Core Memory K/V。", memoryKind: "workflow", sourceSession: "25170f2c-01b4-4eae-a1f2-ccafa77e3e62", sourceLabel: "记忆系统 DIFF 报告" },
  { id: "tz-047", text: "第 4 层是 context compaction。", memoryKind: "workflow", sourceSession: "25170f2c-01b4-4eae-a1f2-ccafa77e3e62", sourceLabel: "记忆系统 DIFF 报告" },
  { id: "tz-048", text: "当前 OpenClaw 本地已经有会话历史和 workspace memory 日志。", memoryKind: "workflow", sourceSession: "25170f2c-01b4-4eae-a1f2-ccafa77e3e62", sourceLabel: "记忆系统 DIFF 报告" },
  { id: "tz-049", text: "当前长期记忆写入方式包括显式 memory_store 和自动 capture。", memoryKind: "workflow", sourceSession: "25170f2c-01b4-4eae-a1f2-ccafa77e3e62", sourceLabel: "记忆系统 DIFF 报告" },
  { id: "tz-050", text: "当前系统的明显短板之一是召回链路曾经不稳定。", memoryKind: "workflow", sourceSession: "25170f2c-01b4-4eae-a1f2-ccafa77e3e62", sourceLabel: "记忆系统 DIFF 报告" },
];

export const TURNING_ZERO_RECALL_CASES: TurningZeroRecallCase[] = [
  { id: "rq-01", query: "用户叫什么名字？", expected: "小明", memoryKinds: ["profile"] },
  { id: "rq-02", query: "用户的时区是什么？", expected: "UTC+8", memoryKinds: ["profile"] },
  { id: "rq-03", query: "用户最重要的关系对象是谁？", expected: "伴侣", memoryKinds: ["relationship"] },
  { id: "rq-04", query: "用户偏好什么沟通方式？", expected: "异步沟通", memoryKinds: ["preference"] },
  { id: "rq-05", query: "memU embedding 现在用什么？", expected: "nomic-embed-text", memoryKinds: ["tooling"] },
  { id: "rq-06", query: "memU retrieve 优化时关闭了什么？", expected: "route_intention", memoryKinds: ["tooling"] },
  { id: "rq-07", query: "记忆系统一共有几层？", expected: "四层", memoryKinds: ["workflow"] },
  { id: "rq-08", query: "记忆系统的第3层是什么？", expected: "Core Memory K/V", memoryKinds: ["workflow"] },
  { id: "rq-09", query: "turning_zero 遇到缺乏数据时应该怎么做？", expected: "调用工具检索", memoryKinds: ["workflow"] },
  { id: "rq-10", query: "当前系统的一个明显短板是什么？", expected: "召回链路曾经不稳定", memoryKinds: ["workflow"] },
];
