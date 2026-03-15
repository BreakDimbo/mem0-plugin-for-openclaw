import type { FreeTextMemoryKind, FreeTextMemoryMetadata, MemuMemoryRecord, MemoryScope } from "./types.js";
import type { FreeTextSearchOptions } from "./backends/free-text/base.js";

export function buildFreeTextMetadata(
  text: string,
  scope: MemoryScope,
  opts?: {
    captureKind?: "explicit" | "auto";
    context?: string;
    extra?: Record<string, unknown>;
  },
): FreeTextMemoryMetadata {
  const memoryKind = inferFreeTextMemoryKind(text, opts?.context);
  return {
    source: "memory-mem0",
    content_kind: "free-text",
    capture_kind: opts?.captureKind,
    memory_kind: memoryKind,
    quality: inferQuality(text),
    workspace_agent: scope.agentId,
    scope_user_id: scope.userId,
    scope_agent_id: scope.agentId,
    scope_session_key: scope.sessionKey,
    ...(opts?.extra ?? {}),
  };
}

export function inferFreeTextMemoryKind(text: string, context?: string): FreeTextMemoryKind {
  const normalized = `${text} ${context ?? ""}`.trim().toLowerCase();

  if (/\b(postmortem|retrospective|lesson learned|takeaway|learned that|in hindsight)\b|复盘|经验|教训|启发|总结得出/.test(normalized)) return "lesson";
  if (/\b(benchmark|p95|latency|throughput|cost|pricing|qps|rps|timeout|cbresetms|dimension)\b|基准|延迟|吞吐|成本|费用|超时|维度|性能/.test(normalized)) return "benchmark";
  if (/\b(decision|decided|we chose|tradeoff|reasoning|because we|agreed to|disabled|enabled|turned off|turned on)\b|决策|决定|取舍|原因|因为|约定|采用了|关闭|开启|状态为/.test(normalized)) return "decision";
  if (/\b(architecture|layer|pipeline|storage model|memory architecture|compaction|jsonl|kv|schema)\b|架构|分层|管线|存储模型|记忆架构|压缩|日志|键值|模式/.test(normalized)) return "architecture";
  if (/\b(config|setting|classifier|router|feature flag|embedding|model|retriev|route_intention|sufficiency_check)\b|配置|参数|分类器|路由|特性开关|embedding|模型|检索/.test(normalized)) return "technical";
  if (/\b(job|career|work context|employer|company role|full-time work)\b|工作内容|职业背景|全职工作|岗位|公司角色/.test(normalized)) return "work";
  if (/\b(editor|neovim|vscode|shell|zsh|git|github actions|database|postgresql|python|pnpm|ruff|biome|aws|package manager|tool|framework|astro|obsidian|1password|msw|linter|formatter|ci provider)\b|编辑器|工具|数据库|包管理|框架|格式化|代码检查|云服务/.test(normalized)) return "tooling";
  if (/\b(prefers?|preference|likes?|dislikes?|favorite|favou?rite)\b|喜欢|偏好|更喜欢|不喜欢|最喜欢/.test(normalized)) return "preference";
  if (/\b(always|never|must|must not|do not|don't|avoid|forbid|forbidden|required)\b|必须|不能|不要|禁止|避免|规则|约束/.test(normalized)) return "constraint";
  if (/\b(name|timezone|based in|from the|works from|home timezone|phone|laptop|browser|keyboard|office)\b|名字|时区|办公室|住在|手机|电脑|笔记本|浏览器|键盘/.test(normalized)) return "profile";
  if (/\b(partner|wife|husband|friend|colleague|teammate)\b|伴侣|妻子|老婆|丈夫|朋友|同事|队友/.test(normalized)) return "relationship";
  if (/\b(every|weekday|friday|sunday|night|morning|afternoon|evening|at \\d|am|pm|schedule|backup|retrospective|budget)\b|每天|每周|周五|周日|晚上|早上|下午|几点|什么时候|日程|备份|复盘|预算/.test(normalized)) return "schedule";
  if (/\b(project|workspace|documentation|docs directory|newsletters|research)\b|项目|工作区|文档|资料|通讯|研究/.test(normalized)) return "project";
  if (/\b(workflow|review|refactor|summary|pull request|code review|task tracker)\b|工作流|流程|评审|重构|总结|任务追踪|代码审查/.test(normalized)) return "workflow";
  return "general";
}

export function inferQuality(text: string): "durable" | "transient" {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return "transient";
  if (/\b(today|tomorrow|tonight|this morning|this afternoon|this evening|next week)\b/.test(normalized)) return "transient";
  if (/\btest(ing)?\b|\bdebug\b|\boutbox\b|\bbenchmark\b|\bsmoke\b/.test(normalized)) return "transient";
  if (/测试|调试|联调|修复/.test(normalized)) return "transient";
  return "durable";
}

export function metadataKindLabel(metadata: Record<string, unknown> | undefined): string | undefined {
  const kind = typeof metadata?.memory_kind === "string" ? metadata.memory_kind : undefined;
  return kind && kind !== "general" ? kind : undefined;
}

export function matchesMetadataFilters(
  metadata: Record<string, unknown> | undefined,
  options: Pick<FreeTextSearchOptions, "quality" | "memoryKinds" | "captureKind"> | undefined,
): boolean {
  if (!options) return true;

  const quality = typeof metadata?.quality === "string" ? metadata.quality : undefined;
  const kind = typeof metadata?.memory_kind === "string" ? metadata.memory_kind : undefined;
  const captureKind = typeof metadata?.capture_kind === "string" ? metadata.capture_kind : undefined;

  if (options.quality && quality !== options.quality) return false;
  if (options.captureKind && captureKind !== options.captureKind) return false;
  if (options.memoryKinds?.length && (!kind || !options.memoryKinds.includes(kind))) return false;

  return true;
}

export function inferQueryKindHints(query: string): FreeTextMemoryKind[] {
  const normalized = query.trim().toLowerCase();
  const hints = new Set<FreeTextMemoryKind>();

  if (!normalized) return [];

  const technicalLike = /\b(config|setting|model|embedding|retriev|latency|cost|timeout|dimension|router|classifier)\b|配置|参数|模型|embedding|检索|延迟|成本|超时|维度|路由|分类器/.test(normalized);
  const decisionLike = /\b(decision|decided|tradeoff|why did|why was)\b|决策|取舍|为什么采用|为什么关闭|为什么开启/.test(normalized);
  const architectureLike = /\b(architecture|layer|pipeline|storage model|memory architecture)\b|架构|分层|管线|存储模型|记忆架构|第.?层/.test(normalized);
  const workLike = /\b(job|career|employer|full-time work|role at work)\b|工作内容|职业背景|全职工作|岗位/.test(normalized);
  const lessonLike = /\b(lesson|takeaway|what did we learn|retrospective)\b|经验|教训|启发|复盘/.test(normalized);
  const benchmarkLike = /\b(p95|latency|throughput|cost|pricing|benchmark|timeout|dimension)\b|延迟|吞吐|成本|费用|基准|超时|维度/.test(normalized);
  const toolingLike = /\b(editor|tool|database|language|linter|formatter|package manager|framework|ci|cloud|python)\b|编辑器|工具|数据库|语言|包管理|框架|格式化|代码检查|云服务/.test(normalized);
  const profileLike = /\b(name|timezone|office|based|live|phone|laptop|browser|keyboard)\b|名字|时区|办公室|住在|手机|电脑|浏览器|键盘/.test(normalized);
  const relationshipLike = /\b(partner|wife|husband|friend|colleague)\b|伴侣|妻子|老婆|丈夫|朋友|同事/.test(normalized);
  const scheduleLike = /\b(when|time|schedule|every|weekday|morning|afternoon|evening|night)\b|什么时候|几点|日程|每天|每周|周几|早上|下午|晚上/.test(normalized);
  const projectLike = /\b(project|docs|documentation|workspace|research|newsletter)\b|项目|文档|工作区|研究|通讯/.test(normalized);
  const workflowLike = /\b(review|workflow|refactor|summary|pull request|task tracker)\b|评审|流程|重构|总结|任务追踪|代码审查/.test(normalized);
  const constraintLike = /\b(rule|constraint|must|must not|avoid|forbid|approval)\b|规则|约束|必须|不能|不要|禁止|审批/.test(normalized);
  const preferenceLike = /\b(prefer|favorite|like|dislike|drink|taste)\b|喜欢|偏好|更喜欢|口味|饮料/.test(normalized);

  if (technicalLike) hints.add("technical");
  if (decisionLike) hints.add("decision");
  if (architectureLike) hints.add("architecture");
  if (workLike) hints.add("work");
  if (lessonLike) hints.add("lesson");
  if (benchmarkLike) hints.add("benchmark");
  if (toolingLike) hints.add("tooling");
  if (profileLike) hints.add("profile");
  if (relationshipLike) hints.add("relationship");
  if (scheduleLike) hints.add("schedule");
  if (projectLike) hints.add("project");
  if (workflowLike) hints.add("workflow");
  if (constraintLike) hints.add("constraint");

  // Allow preference to overlap with other kinds — "更喜欢用什么编辑器" should
  // match both "tooling" and "preference" memories.
  if (preferenceLike) {
    hints.add("preference");
  }

  return Array.from(hints);
}

export function rerankMemoryResults(
  query: string,
  items: MemuMemoryRecord[],
  opts?: { preferDurable?: boolean },
): MemuMemoryRecord[] {
  const hints = inferQueryKindHints(query);
  const preferDurable = opts?.preferDurable !== false;

  return [...items].sort((left, right) => {
    const scoreDiff = scoreMemoryForQuery(query, right, hints, preferDurable) - scoreMemoryForQuery(query, left, hints, preferDurable);
    if (scoreDiff !== 0) return scoreDiff;
    return (right.createdAt ?? 0) - (left.createdAt ?? 0);
  });
}

export function tokenizeSemanticQuery(query: string): string[] {
  const lower = query.toLowerCase();
  const tokens = new Set<string>();
  for (const word of lower.match(/[a-z0-9_+-]{2,}/g) ?? []) tokens.add(word);
  for (const chunk of lower.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    tokens.add(chunk);
    for (let i = 0; i <= chunk.length - 2; i++) tokens.add(chunk.slice(i, i + 2));
  }
  return Array.from(tokens);
}

function scoreMemoryForQuery(
  query: string,
  item: MemuMemoryRecord,
  hints: FreeTextMemoryKind[],
  preferDurable: boolean,
): number {
  const metadata = item.metadata;
  const quality = typeof metadata?.quality === "string" ? metadata.quality : undefined;
  const kind = typeof metadata?.memory_kind === "string" ? metadata.memory_kind : undefined;
  const captureKind = typeof metadata?.capture_kind === "string" ? metadata.capture_kind : undefined;

  let score = item.score ?? 0;

  if (preferDurable) {
    if (quality === "durable") score += 0.12;
    if (quality === "transient") score -= 0.12;
  }

  if (captureKind === "explicit") score += 0.05;
  if (captureKind === "auto") score += 0.01;

  if (kind && hints.length > 0) {
    if (hints.includes(kind as FreeTextMemoryKind)) {
      score += 0.18;
    } else if (kind !== "general") {
      score -= 0.03;
    }
  }

  score += genericConceptBoost(query, item.text);

  return score;
}

type QueryConcept = {
  query: RegExp;
  item: RegExp;
  bonus: number;
};

const QUERY_CONCEPTS: QueryConcept[] = [
  { query: /饮料|喝什么|喝啥|drink|beverage/i, item: /饮料|茶|咖啡|口味/i, bonus: 0.22 },
  { query: /编辑器|开发工具|editor|ide/i, item: /编辑器|工具|终端|代码/i, bonus: 0.20 },
  { query: /笔记|记录|知识库|note/i, item: /笔记|记录|知识库|vault/i, bonus: 0.18 },
  { query: /沟通|表达|风格|communication|style/i, item: /沟通|表达|风格|直击要害|结论先行/i, bonus: 0.18 },
  { query: /时间|什么时候|时区|timezone|timestamp|日志/i, item: /时间|时区|时间戳|日志|utc/i, bonus: 0.18 },
  { query: /关系|伴侣|家人|同事|relationship|partner/i, item: /伴侣|家人|同事|关系|住在/i, bonus: 0.18 },
  { query: /项目|目标|project|goal/i, item: /项目|目标|方向|转型|探索/i, bonus: 0.16 },
  { query: /工具链|包管理|依赖|toolchain|package manager/i, item: /工具链|包管理|依赖|环境/i, bonus: 0.18 },
  { query: /图表|示意图|diagram/i, item: /图表|流程图|示意图/i, bonus: 0.16 },
  { query: /会议|日历|排期|calendar|schedule/i, item: /会议|日历|排期|日程/i, bonus: 0.16 },
  { query: /架构|层|workflow|memory architecture/i, item: /架构|分层|层|日志|长期记忆|核心记忆|压缩/i, bonus: 0.18 },
  { query: /配置|参数|模型|embedding|retriev|router|classifier|latency|cost|timeout|dimension/i, item: /配置|参数|模型|embedding|检索|路由|分类器|延迟|成本|超时|维度/i, bonus: 0.18 },
  { query: /决策|取舍|为什么|decision|tradeoff/i, item: /决策|取舍|原因|关闭|开启|采用/i, bonus: 0.16 },
  { query: /经验|教训|复盘|lesson|takeaway/i, item: /经验|教训|复盘|总结|启发/i, bonus: 0.16 },
];

/** Character-trigram similarity (Dice coefficient). Reusable across capture dedup and consolidation. */
export function trigramSimilarity(a: string, b: string): number {
  const trigramsOf = (s: string): Set<string> => {
    const t = new Set<string>();
    const lower = s.toLowerCase();
    for (let i = 0; i <= lower.length - 3; i++) {
      t.add(lower.slice(i, i + 3));
    }
    return t;
  };

  const ta = trigramsOf(a);
  const tb = trigramsOf(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  let overlap = 0;
  for (const t of ta) {
    if (tb.has(t)) overlap++;
  }

  return (2 * overlap) / (ta.size + tb.size);
}

export function genericConceptBoost(query: string, text: string): number {
  let boost = 0;
  for (const concept of QUERY_CONCEPTS) {
    if (concept.query.test(query) && concept.item.test(text)) {
      boost += concept.bonus;
    }
  }
  return boost;
}
