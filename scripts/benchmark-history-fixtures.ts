import type { FreeTextMemoryKind } from "../types.js";

export type HistoryFact = {
  id: string;
  text: string;
  memoryKind: FreeTextMemoryKind;
  sourceLabel: string;
};

export type RecallCase = {
  id: string;
  query: string;
  expected: string;
  memoryKinds?: FreeTextMemoryKind[];
};

/**
 * Simulated free-text memory facts for benchmark seeding.
 * Each fact represents what the capture pipeline would extract from
 * real conversations — natural language, varying granularity, some overlap.
 */
export const BENCHMARK_HISTORY_FACTS: HistoryFact[] = [
  // --- profile (extracted from intro conversations) ---
  { id: "hf-001", text: "用户名字叫昊。", memoryKind: "profile", sourceLabel: "自我介绍对话" },
  { id: "hf-002", text: "用户所在时区是 UTC+8。", memoryKind: "profile", sourceLabel: "自我介绍对话" },
  { id: "hf-003", text: "用户是字节跳动资深后端架构师。", memoryKind: "profile", sourceLabel: "自我介绍对话" },
  { id: "hf-004", text: "用户深耕分布式系统与高并发场景。", memoryKind: "profile", sourceLabel: "自我介绍对话" },
  { id: "hf-005", text: "用户的人格倾向是 INTJ。", memoryKind: "profile", sourceLabel: "自我介绍对话" },
  { id: "hf-006", text: "用户常驻北京。", memoryKind: "profile", sourceLabel: "自我介绍对话" },

  // --- preferences (extracted from daily chats) ---
  { id: "hf-007", text: "用户偏好平静、专业、直击要害的沟通风格。", memoryKind: "preference", sourceLabel: "沟通偏好讨论" },
  { id: "hf-008", text: "用户偏好结论先行、核心论点前置的金字塔表达。", memoryKind: "preference", sourceLabel: "沟通偏好讨论" },
  { id: "hf-009", text: "用户偏好异步沟通。", memoryKind: "preference", sourceLabel: "沟通偏好讨论" },
  { id: "hf-010", text: "用户讨厌废话和 AI 客套话。", memoryKind: "constraint", sourceLabel: "AI 使用反馈" },
  { id: "hf-011", text: "用户上午和晚上最高效。", memoryKind: "schedule", sourceLabel: "时间管理讨论" },
  { id: "hf-012", text: "用户最喜欢的饮料是手冲咖啡。", memoryKind: "preference", sourceLabel: "闲聊" },
  { id: "hf-013", text: "用户日常使用 Neovim 作为主力编辑器。", memoryKind: "tooling", sourceLabel: "开发环境讨论" },

  // --- goals and projects ---
  { id: "hf-014", text: "用户的主目标是借助 AI/LLM 完成从资深程序员到一人公司创业者的转型。", memoryKind: "project", sourceLabel: "职业规划讨论" },
  { id: "hf-015", text: "用户的健康目标是养成健身习惯并减重 30 斤。", memoryKind: "project", sourceLabel: "健康目标讨论" },
  { id: "hf-016", text: "用户正在探索自媒体方向。", memoryKind: "project", sourceLabel: "副业探索讨论" },
  { id: "hf-017", text: "用户正在探索 iOS 开发方向。", memoryKind: "project", sourceLabel: "副业探索讨论" },
  { id: "hf-018", text: "用户正在探索游戏开发方向。", memoryKind: "project", sourceLabel: "副业探索讨论" },
  { id: "hf-019", text: "用户正在探索开源项目开发方向。", memoryKind: "project", sourceLabel: "副业探索讨论" },

  // --- relationships ---
  { id: "hf-020", text: "用户最重要的关系对象是爱人。", memoryKind: "relationship", sourceLabel: "家庭话题" },

  // --- constraints ---
  { id: "hf-021", text: "用户对技术问题上的捏造或幻觉零容忍。", memoryKind: "constraint", sourceLabel: "AI 使用反馈" },
  { id: "hf-022", text: "用户对冗余、低效和无逻辑的堆砌零容忍。", memoryKind: "constraint", sourceLabel: "协作规范讨论" },
  { id: "hf-023", text: "删除操作需要先确认，优先使用 trash 而不是 rm。", memoryKind: "constraint", sourceLabel: "操作规范讨论" },
  { id: "hf-024", text: "对外部行动、发送、发布和不可逆操作需要确认。", memoryKind: "constraint", sourceLabel: "操作规范讨论" },
  { id: "hf-025", text: "隐私保护是红线，不暴露私有架构代码和敏感配置。", memoryKind: "constraint", sourceLabel: "安全规范讨论" },

  // --- technical decisions (extracted from project logs) ---
  { id: "hf-026", text: "smart-router 分类器已改回 gemini-3.1-flash-lite-preview。", memoryKind: "technical", sourceLabel: "项目日志 2026-03-07" },
  { id: "hf-027", text: "memU retrieve 优化时关闭了 route_intention。", memoryKind: "decision", sourceLabel: "项目日志 2026-03-07" },
  { id: "hf-028", text: "memU retrieve 优化时关闭了 sufficiency_check。", memoryKind: "decision", sourceLabel: "项目日志 2026-03-07" },
  { id: "hf-029", text: "memU retrieve 优化时关闭了 resource 检索。", memoryKind: "decision", sourceLabel: "项目日志 2026-03-07" },
  { id: "hf-030", text: "memU embedding 后来切换为本地 Ollama 的 nomic-embed-text。", memoryKind: "technical", sourceLabel: "项目日志 2026-03-07" },
  { id: "hf-031", text: "nomic-embed-text 的向量维度是 768。", memoryKind: "technical", sourceLabel: "项目日志 2026-03-07" },
  { id: "hf-032", text: "Gemini embedding-001 的向量维度是 3072。", memoryKind: "technical", sourceLabel: "项目日志 2026-03-07" },
  { id: "hf-033", text: "memU-server 优化后 retrieve 的 P95 延迟达到 120ms。", memoryKind: "benchmark", sourceLabel: "项目日志 2026-03-07" },
  { id: "hf-034", text: "memU-server 优化后的月费用接近 0 美元。", memoryKind: "benchmark", sourceLabel: "项目日志 2026-03-07" },
  { id: "hf-035", text: "memory-memu 曾把 retrieve 超时从 1500ms 调到 5000ms。", memoryKind: "technical", sourceLabel: "项目日志 2026-03-07" },
  { id: "hf-036", text: "memory-memu 新增了 cbResetMs=10000ms 的 circuit breaker 配置。", memoryKind: "technical", sourceLabel: "项目日志 2026-03-07" },

  // --- architecture (extracted from design review) ---
  { id: "hf-037", text: "目标记忆架构分为四层。", memoryKind: "architecture", sourceLabel: "记忆系统设计评审" },
  { id: "hf-038", text: "第 1 层是 JSONL 全量对话日志，用于审计和回放。", memoryKind: "architecture", sourceLabel: "记忆系统设计评审" },
  { id: "hf-039", text: "第 2 层是可搜索的长期记忆。", memoryKind: "architecture", sourceLabel: "记忆系统设计评审" },
  { id: "hf-040", text: "第 3 层是支持 importance 和 replace 语义的 Core Memory K/V。", memoryKind: "architecture", sourceLabel: "记忆系统设计评审" },
  { id: "hf-041", text: "第 4 层是 context compaction。", memoryKind: "architecture", sourceLabel: "记忆系统设计评审" },

  // --- lessons (extracted from retros) ---
  { id: "hf-042", text: "当前系统的明显短板之一是召回链路曾经不稳定。", memoryKind: "lesson", sourceLabel: "记忆系统复盘" },
  { id: "hf-043", text: "memory-memu 修复过 Agent ID 识别问题。", memoryKind: "lesson", sourceLabel: "记忆系统复盘" },
  { id: "hf-044", text: "当前记忆体系建议先稳定 recall 链路，再做 Core Memory K/V。", memoryKind: "decision", sourceLabel: "记忆系统复盘" },
  { id: "hf-045", text: "遵循第一性原理思考。", memoryKind: "decision", sourceLabel: "协作规范讨论" },
];

/**
 * Backend recall validation cases — tests raw search + rerank quality.
 */
export const BENCHMARK_RECALL_CASES: RecallCase[] = [
  { id: "rc-01", query: "用户叫什么名字？", expected: "昊", memoryKinds: ["profile"] },
  { id: "rc-02", query: "用户的时区是什么？", expected: "UTC+8", memoryKinds: ["profile"] },
  { id: "rc-03", query: "用户最重要的关系对象是谁？", expected: "爱人", memoryKinds: ["relationship"] },
  { id: "rc-04", query: "用户偏好什么沟通方式？", expected: "异步沟通", memoryKinds: ["preference"] },
  { id: "rc-05", query: "memU embedding 现在用什么？", expected: "nomic-embed-text", memoryKinds: ["technical"] },
  { id: "rc-06", query: "memU retrieve 优化时关闭了什么？", expected: "route_intention", memoryKinds: ["decision"] },
  { id: "rc-07", query: "记忆系统一共有几层？", expected: "四层", memoryKinds: ["architecture"] },
  { id: "rc-08", query: "记忆系统的第3层是什么？", expected: "Core Memory K/V", memoryKinds: ["architecture"] },
  { id: "rc-09", query: "缺乏数据时应该怎么做？", expected: "调用工具检索", memoryKinds: ["decision"] },
  { id: "rc-10", query: "当前系统的一个明显短板是什么？", expected: "召回链路", memoryKinds: ["lesson"] },
];
