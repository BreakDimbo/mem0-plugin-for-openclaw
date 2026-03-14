export type CoreBackfillItem = {
  category: string;
  key: string;
  value: string;
  importance: number;
  provenance: string;
};

export const TURNING_ZERO_CORE_BACKFILL_ITEMS: CoreBackfillItem[] = [
  { category: "identity", key: "identity.name", value: "用户叫小明。", importance: 10, provenance: "benchmark-core-backfill" },
  { category: "identity", key: "identity.timezone", value: "用户的时区是 UTC+8。", importance: 9, provenance: "benchmark-core-backfill" },
  { category: "identity", key: "identity.current_role", value: "用户现在的职业是某互联网公司高级后端工程师。", importance: 9, provenance: "benchmark-core-backfill" },
  { category: "identity", key: "identity.specialization", value: "用户主要深耕分布式系统与高并发。", importance: 9, provenance: "benchmark-core-backfill" },
  { category: "identity", key: "identity.personality", value: "用户的人格倾向是 INTJ。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "goals", key: "goals.primary", value: "用户的主目标是成为一人公司创业者。", importance: 10, provenance: "benchmark-core-backfill" },
  { category: "goals", key: "goals.health", value: "用户的健康目标是保持健康体重。", importance: 9, provenance: "benchmark-core-backfill" },
  { category: "identity", key: "identity.full_time_job", value: "用户当前的全职工作是某互联网公司程序员。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "goals", key: "goals.exploration.media", value: "用户正在探索的媒体方向是自媒体。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "goals", key: "goals.exploration.mobile", value: "用户正在探索的移动端开发方向是iOS开发。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "goals", key: "goals.exploration.game", value: "用户正在探索的游戏相关方向是游戏开发。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "goals", key: "goals.exploration.opensource", value: "用户正在探索的开放协作方向是开源项目。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "relationships", key: "relationships.primary", value: "用户最重要的关系对象是伴侣。", importance: 10, provenance: "benchmark-core-backfill" },
  { category: "preferences", key: "preferences.communication_style", value: "用户偏好的沟通风格是平静、专业、直击要害。", importance: 9, provenance: "benchmark-core-backfill" },
  { category: "preferences", key: "preferences.expression_style", value: "用户偏好的表达方式是金字塔结构。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "preferences", key: "preferences.peak_hours", value: "用户一天里上午和晚上最高效。", importance: 7, provenance: "benchmark-core-backfill" },
  { category: "preferences", key: "preferences.communication_mode", value: "用户偏好异步沟通。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "preferences", key: "preferences.disliked_ai_style", value: "用户讨厌AI客套话。", importance: 7, provenance: "benchmark-core-backfill" },
  { category: "relationships", key: "relationships.turning_zero.role", value: "turning_zero 对用户来说是数字外脑与首席幕僚。", importance: 9, provenance: "benchmark-core-backfill" },
  {
    category: "constraints",
    key: "constraints.turning_zero.missing_data",
    value:
      "只有当前 prompt、注入的 memory facts、USER.md、MEMORY.md 与相关 workspace notes 都没有答案时，turning_zero 才需要调用工具检索。",
    importance: 10,
    provenance: "benchmark-core-backfill",
  },
  { category: "constraints", key: "constraints.turning_zero.reasoning_method", value: "turning_zero 遵循第一性原理。", importance: 9, provenance: "benchmark-core-backfill" },
  { category: "constraints", key: "constraints.turning_zero.privacy", value: "turning_zero 的隐私原则是隐私保护。", importance: 10, provenance: "benchmark-core-backfill" },
  { category: "constraints", key: "constraints.turning_zero.delete_default", value: "turning_zero 对删除操作的默认要求是使用trash。", importance: 9, provenance: "benchmark-core-backfill" },
  { category: "constraints", key: "constraints.turning_zero.external_action", value: "turning_zero 对外部行动的默认要求是先确认。", importance: 10, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.smart_router.classifier_model", value: "smart-router 分类器现在的模型是 gemini-3.1-flash-lite-preview。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memu.retrieve.route_intention", value: "memU retrieve 优化时 route_intention 是关闭。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memu.retrieve.sufficiency_check", value: "memU retrieve 优化时 sufficiency_check 是关闭。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memu.retrieve.resource_search", value: "memU retrieve 优化时 resource 检索是关闭。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memu.embedding.model", value: "memU embedding 现在用的模型是 nomic-embed-text。", importance: 9, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memu.embedding.dimension", value: "nomic-embed-text 的向量维度是 768。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.gemini.embedding_001.dimension", value: "Gemini embedding-001 的向量维度是 3072。", importance: 7, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memu_server.retrieve_p95", value: "memU-server 优化后 retrieve 的 P95 延迟是 120ms。", importance: 7, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memu_server.monthly_cost", value: "memU-server 优化后的月费用大概是 0 美元。", importance: 7, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memory_memu.retrieve_timeout", value: "memory-memu 把 retrieve 超时调整到了 5000ms。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memory_memu.cb_reset_ms", value: "memory-memu 的 cbResetMs 配置是 10000ms。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memory_architecture.layers_count", value: "目标记忆架构一共有四层。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memory_architecture.layer1", value: "目标记忆架构的第1层是 JSONL 全量对话日志。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memory_architecture.layer2", value: "目标记忆架构的第2层是可搜索的长期记忆。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memory_architecture.layer3", value: "目标记忆架构的第3层是 Core Memory K/V。", importance: 8, provenance: "benchmark-core-backfill" },
  { category: "general", key: "general.memory_architecture.layer4", value: "目标记忆架构的第4层是 context compaction。", importance: 8, provenance: "benchmark-core-backfill" },
];
