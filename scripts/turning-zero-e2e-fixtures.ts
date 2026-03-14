export type E2ECase = {
  id: string;
  query: string;
  expected: string;
};

export const TURNING_ZERO_E2E_CASES: E2ECase[] = [
  // --- User profile: direct ---
  { id: "e2e-01", query: "用户叫什么名字", expected: "小明" },
  { id: "e2e-02", query: "用户的时区是什么", expected: "UTC+8" },
  { id: "e2e-03", query: "用户现在的职业是什么", expected: "某互联网公司" },
  { id: "e2e-04", query: "用户主要深耕什么技术领域", expected: "分布式系统" },
  { id: "e2e-05", query: "用户的人格倾向是什么", expected: "INTJ" },
  // --- User profile: rephrased / abbreviated ---
  { id: "e2e-06", query: "用户在哪家公司上班", expected: "某互联网公司" },
  { id: "e2e-07", query: "用户深耕哪个技术领域", expected: "分布式系统" },
  { id: "e2e-08", query: "用户的 MBTI 类型是什么", expected: "INTJ" },
  { id: "e2e-09", query: "用户所在时区是 UTC 几", expected: "UTC+8" },

  // --- Goals: direct ---
  { id: "e2e-10", query: "用户的主目标是什么", expected: "一人公司" },
  { id: "e2e-11", query: "用户的健康目标是什么", expected: "减重" },
  { id: "e2e-12", query: "用户当前的全职工作是什么", expected: "某互联网公司" },
  { id: "e2e-13", query: "用户正在探索哪个媒体方向", expected: "自媒体" },
  { id: "e2e-14", query: "用户正在探索哪种移动端开发", expected: "iOS" },
  { id: "e2e-15", query: "用户正在探索哪种游戏相关方向", expected: "游戏开发" },
  { id: "e2e-16", query: "用户正在探索哪种开放协作方向", expected: "开源" },
  // --- Goals: rephrased ---
  { id: "e2e-17", query: "用户想成为什么类型的创业者", expected: "一人公司" },
  { id: "e2e-18", query: "用户减重目标是多少斤", expected: "30" },
  { id: "e2e-19", query: "iOS 开发是用户的探索方向吗", expected: "是" },

  // --- Relationships ---
  { id: "e2e-20", query: "用户最重要的关系对象是谁", expected: "伴侣" },
  { id: "e2e-21", query: "用户有没有伴侣", expected: "伴侣" },

  // --- Preferences: direct ---
  { id: "e2e-22", query: "用户偏好的沟通风格是什么", expected: "直击要害" },
  { id: "e2e-23", query: "用户偏好的表达方式是什么", expected: "金字塔" },
  { id: "e2e-24", query: "用户一天里什么时候最高效", expected: "上午" },
  { id: "e2e-25", query: "用户偏好什么沟通方式", expected: "异步" },
  { id: "e2e-26", query: "用户讨厌什么类型的 AI 表达", expected: "客套话" },
  // --- Preferences: rephrased / verification ---
  { id: "e2e-27", query: "用户喜欢异步还是同步沟通", expected: "异步" },
  { id: "e2e-28", query: "用户对 AI 客套话的态度", expected: "讨厌" },
  { id: "e2e-29", query: "用户效率最高的时段是哪段", expected: "上午" },

  // --- turning_zero constraints: direct ---
  { id: "e2e-30", query: "turning_zero 对用户来说是什么角色", expected: "数字外脑" },
  { id: "e2e-31", query: "turning_zero 在缺乏数据时应该怎么做", expected: "工具检索" },
  { id: "e2e-32", query: "turning_zero 遵循什么思考方法", expected: "第一性原理" },
  { id: "e2e-33", query: "turning_zero 的隐私原则是什么", expected: "隐私保护" },
  { id: "e2e-34", query: "turning_zero 对删除操作的默认要求是什么", expected: "trash" },
  { id: "e2e-35", query: "turning_zero 对外部行动的默认要求是什么", expected: "确认" },
  // --- turning_zero constraints: rephrased ---
  { id: "e2e-36", query: "turning_zero 缺乏信息时应如何处理", expected: "工具检索" },
  { id: "e2e-37", query: "turning_zero 删除文件时的默认做法是什么", expected: "trash" },

  // --- Technical config: direct ---
  { id: "e2e-38", query: "smart-router 分类器现在是什么模型", expected: "gemini" },
  { id: "e2e-39", query: "memU retrieve 优化时 route_intention 是什么状态", expected: "关闭" },
  { id: "e2e-40", query: "memU retrieve 优化时 sufficiency_check 是什么状态", expected: "关闭" },
  { id: "e2e-41", query: "memU retrieve 优化时 resource 检索是什么状态", expected: "关闭" },
  { id: "e2e-42", query: "memU embedding 现在用什么模型", expected: "nomic" },
  { id: "e2e-43", query: "nomic-embed-text 的向量维度是多少", expected: "768" },
  { id: "e2e-44", query: "Gemini embedding-001 的向量维度是多少", expected: "3072" },
  { id: "e2e-45", query: "memU-server 优化后 retrieve 的 P95 延迟是多少", expected: "120ms" },
  { id: "e2e-46", query: "memU-server 优化后的月费用大概是多少", expected: "0 美元" },
  { id: "e2e-47", query: "memory-memu 把 retrieve 超时调整到了多少", expected: "5000ms" },
  { id: "e2e-48", query: "memory-memu 的 cbResetMs 配置是多少", expected: "10000ms" },
  // --- Technical config: abbreviated / English-Chinese mix ---
  { id: "e2e-49", query: "路由分类器用什么模型", expected: "gemini" },
  { id: "e2e-50", query: "nomic 向量维度是多少", expected: "768" },
  { id: "e2e-51", query: "retrieve P95 延迟是多少", expected: "120ms" },
  { id: "e2e-52", query: "cbResetMs 是多少", expected: "10000ms" },
  { id: "e2e-53", query: "retrieve 超时是多少", expected: "5000ms" },
  { id: "e2e-54", query: "gemini embedding 维度是多少", expected: "3072" },

  // --- Architecture: Arabic numeral ordinals (baseline) ---
  { id: "e2e-55", query: "目标记忆架构一共有几层", expected: "四层" },
  { id: "e2e-56", query: "目标记忆架构的第1层是什么", expected: "JSONL" },
  { id: "e2e-57", query: "目标记忆架构的第2层是什么", expected: "长期记忆" },
  { id: "e2e-58", query: "目标记忆架构的第3层是什么", expected: "Core Memory" },
  { id: "e2e-59", query: "目标记忆架构的第4层是什么", expected: "context compaction" },
  // --- Architecture: Chinese numeral ordinals (tests 一/二/三/四 → 1/2/3/4 normalization) ---
  { id: "e2e-60", query: "目标记忆架构的第一层是什么", expected: "JSONL" },
  { id: "e2e-61", query: "目标记忆架构的第二层是什么", expected: "长期记忆" },
  { id: "e2e-62", query: "目标记忆架构的第三层是什么", expected: "Core Memory" },
  { id: "e2e-63", query: "目标记忆架构的第四层是什么", expected: "context compaction" },
];
