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

  const toolingLike = /\b(editor|tool|database|language|linter|formatter|package manager|framework|ci|cloud|python)\b|编辑器|工具|数据库|语言|包管理|框架|格式化|代码检查|云服务/.test(normalized);
  const profileLike = /\b(name|timezone|office|based|live|phone|laptop|browser|keyboard)\b|名字|时区|办公室|住在|手机|电脑|浏览器|键盘/.test(normalized);
  const relationshipLike = /\b(partner|wife|husband|friend|colleague)\b|伴侣|妻子|老婆|丈夫|朋友|同事/.test(normalized);
  const scheduleLike = /\b(when|time|schedule|every|weekday|morning|afternoon|evening|night)\b|什么时候|几点|日程|每天|每周|周几|早上|下午|晚上/.test(normalized);
  const projectLike = /\b(project|docs|documentation|workspace|research|newsletter)\b|项目|文档|工作区|研究|通讯/.test(normalized);
  const workflowLike = /\b(review|workflow|refactor|summary|pull request|task tracker)\b|评审|流程|重构|总结|任务追踪|代码审查/.test(normalized);
  const constraintLike = /\b(rule|constraint|must|must not|avoid|forbid|approval)\b|规则|约束|必须|不能|不要|禁止|审批/.test(normalized);
  const preferenceLike = /\b(prefer|favorite|like|dislike|drink|taste)\b|喜欢|偏好|更喜欢|口味|饮料/.test(normalized);

  if (toolingLike) hints.add("tooling");
  if (profileLike) hints.add("profile");
  if (relationshipLike) hints.add("relationship");
  if (scheduleLike) hints.add("schedule");
  if (projectLike) hints.add("project");
  if (workflowLike) hints.add("workflow");
  if (constraintLike) hints.add("constraint");

  // In Chinese, preference words often appear inside tooling/profile queries
  // ("更喜欢用什么编辑器"), so only treat them as preference-first when the
  // query does not already specify a stronger domain noun.
  if (preferenceLike && !toolingLike && !profileLike && !scheduleLike && !relationshipLike && !projectLike && !workflowLike) {
    hints.add("preference");
  } else if (preferenceLike && normalized.includes("饮料")) {
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
];

export function genericConceptBoost(query: string, text: string): number {
  let boost = 0;
  for (const concept of QUERY_CONCEPTS) {
    if (concept.query.test(query) && concept.item.test(text)) {
      boost += concept.bonus;
    }
  }
  return boost;
}
