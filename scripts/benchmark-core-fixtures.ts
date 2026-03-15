export type CoreBackfillItem = {
  category: string;
  key: string;
  value: string;
  importance: number;
  provenance: string;
};

/**
 * Self-contained core memory fixtures for benchmark.
 * Covers: profile, goals, relationships, preferences, constraints,
 * technical config, architecture, decisions, lessons.
 *
 * These are agent-agnostic — they describe a fictional but realistic user
 * profile so the benchmark can run against any OpenClaw agent.
 */
export const BENCHMARK_CORE_ITEMS: CoreBackfillItem[] = [
  // --- identity / profile ---
  { category: "identity", key: "identity.name", value: "用户叫昊。", importance: 10, provenance: "benchmark" },
  { category: "identity", key: "identity.timezone", value: "用户的时区是 UTC+8。", importance: 9, provenance: "benchmark" },
  { category: "identity", key: "identity.current_role", value: "用户现在的职业是字节跳动资深后端架构师。", importance: 9, provenance: "benchmark" },
  { category: "identity", key: "identity.specialization", value: "用户主要深耕分布式系统与高并发。", importance: 9, provenance: "benchmark" },
  { category: "identity", key: "identity.personality", value: "用户的人格倾向是 INTJ。", importance: 8, provenance: "benchmark" },
  { category: "identity", key: "identity.location", value: "用户常驻北京。", importance: 7, provenance: "benchmark" },

  // --- goals ---
  { category: "goals", key: "goals.primary", value: "用户的主目标是成为一人公司创业者。", importance: 10, provenance: "benchmark" },
  { category: "goals", key: "goals.health", value: "用户的健康目标是减重30斤。", importance: 9, provenance: "benchmark" },
  { category: "goals", key: "goals.exploration.media", value: "用户正在探索的媒体方向是自媒体。", importance: 8, provenance: "benchmark" },
  { category: "goals", key: "goals.exploration.mobile", value: "用户正在探索的移动端开发方向是iOS开发。", importance: 8, provenance: "benchmark" },
  { category: "goals", key: "goals.exploration.game", value: "用户正在探索的游戏相关方向是游戏开发。", importance: 8, provenance: "benchmark" },
  { category: "goals", key: "goals.exploration.opensource", value: "用户正在探索的开放协作方向是开源项目。", importance: 8, provenance: "benchmark" },

  // --- relationships ---
  { category: "relationships", key: "relationships.primary", value: "用户最重要的关系对象是爱人。", importance: 10, provenance: "benchmark" },

  // --- preferences ---
  { category: "preferences", key: "preferences.communication_style", value: "用户偏好的沟通风格是平静、专业、直击要害。", importance: 9, provenance: "benchmark" },
  { category: "preferences", key: "preferences.expression_style", value: "用户偏好的表达方式是金字塔结构。", importance: 8, provenance: "benchmark" },
  { category: "preferences", key: "preferences.peak_hours", value: "用户一天里上午和晚上最高效。", importance: 7, provenance: "benchmark" },
  { category: "preferences", key: "preferences.communication_mode", value: "用户偏好异步沟通。", importance: 8, provenance: "benchmark" },
  { category: "preferences", key: "preferences.disliked_ai_style", value: "用户讨厌AI客套话。", importance: 7, provenance: "benchmark" },
  { category: "preferences", key: "preferences.drink", value: "用户最喜欢的饮料是手冲咖啡。", importance: 6, provenance: "benchmark" },
  { category: "preferences", key: "preferences.editor", value: "用户日常使用 Neovim 作为主力编辑器。", importance: 7, provenance: "benchmark" },

  // --- constraints ---
  { category: "constraints", key: "constraints.delete_default", value: "删除操作的默认要求是使用trash。", importance: 9, provenance: "benchmark" },
  { category: "constraints", key: "constraints.external_action", value: "外部行动的默认要求是先确认。", importance: 10, provenance: "benchmark" },
  { category: "constraints", key: "constraints.privacy", value: "隐私原则是不暴露私有架构代码和敏感配置。", importance: 10, provenance: "benchmark" },
  { category: "constraints", key: "constraints.reasoning", value: "遵循第一性原理思考。", importance: 9, provenance: "benchmark" },
  { category: "constraints", key: "constraints.missing_data", value: "在缺乏数据时应该调用工具检索，不能编造。", importance: 10, provenance: "benchmark" },

  // --- technical config ---
  { category: "technical", key: "technical.smart_router.classifier_model", value: "smart-router 分类器现在的模型是 gemini-3.1-flash-lite-preview。", importance: 8, provenance: "benchmark" },
  { category: "technical", key: "technical.memu.embedding.model", value: "memU embedding 现在用的模型是 nomic-embed-text。", importance: 9, provenance: "benchmark" },
  { category: "technical", key: "technical.memu.embedding.dimension", value: "nomic-embed-text 的向量维度是 768。", importance: 8, provenance: "benchmark" },
  { category: "technical", key: "technical.gemini.embedding_001.dimension", value: "Gemini embedding-001 的向量维度是 3072。", importance: 7, provenance: "benchmark" },
  { category: "technical", key: "technical.memu_server.retrieve_p95", value: "memU-server 优化后 retrieve 的 P95 延迟是 120ms。", importance: 7, provenance: "benchmark" },
  { category: "technical", key: "technical.memu_server.monthly_cost", value: "memU-server 优化后的月费用大概是 0 美元。", importance: 7, provenance: "benchmark" },
  { category: "technical", key: "technical.memory_memu.retrieve_timeout", value: "memory-memu 把 retrieve 超时调整到了 5000ms。", importance: 8, provenance: "benchmark" },
  { category: "technical", key: "technical.memory_memu.cb_reset_ms", value: "memory-memu 的 cbResetMs 配置是 10000ms。", importance: 8, provenance: "benchmark" },

  // --- architecture ---
  { category: "architecture", key: "architecture.layers_count", value: "目标记忆架构一共有四层。", importance: 8, provenance: "benchmark" },
  { category: "architecture", key: "architecture.layer1", value: "目标记忆架构的第1层是 JSONL 全量对话日志。", importance: 8, provenance: "benchmark" },
  { category: "architecture", key: "architecture.layer2", value: "目标记忆架构的第2层是可搜索的长期记忆。", importance: 8, provenance: "benchmark" },
  { category: "architecture", key: "architecture.layer3", value: "目标记忆架构的第3层是 Core Memory K/V。", importance: 8, provenance: "benchmark" },
  { category: "architecture", key: "architecture.layer4", value: "目标记忆架构的第4层是 context compaction。", importance: 8, provenance: "benchmark" },

  // --- decisions ---
  { category: "decision", key: "decision.memu.route_intention", value: "memU retrieve 优化时 route_intention 是关闭。", importance: 8, provenance: "benchmark" },
  { category: "decision", key: "decision.memu.sufficiency_check", value: "memU retrieve 优化时 sufficiency_check 是关闭。", importance: 8, provenance: "benchmark" },
  { category: "decision", key: "decision.memu.resource_search", value: "memU retrieve 优化时 resource 检索是关闭。", importance: 8, provenance: "benchmark" },
];
