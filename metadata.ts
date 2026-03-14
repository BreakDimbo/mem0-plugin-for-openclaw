import type { FreeTextMemoryKind, FreeTextMemoryMetadata, MemoryScope } from "./types.js";
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
    source: "memory-memu",
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

  if (/\b(prefers?|preference|likes?|dislikes?|favorite|favou?rite)\b/.test(normalized)) return "preference";
  if (/\b(always|never|must|must not|do not|don't|avoid|forbid|forbidden|required)\b/.test(normalized)) return "constraint";
  if (/\b(name|timezone|based in|from the|works from|home timezone|phone|laptop|browser|keyboard)\b/.test(normalized)) return "profile";
  if (/\b(partner|wife|husband|friend|colleague|team|manager)\b/.test(normalized)) return "relationship";
  if (/\b(editor|neovim|vscode|shell|zsh|git|github actions|database|postgresql|python|pnpm|ruff|biome|aws|tool|framework|astro|obsidian|1password|msw)\b/.test(normalized)) return "tooling";
  if (/\b(every|weekday|friday|sunday|night|morning|afternoon|evening|at \\d|am|pm|schedule|backup|retrospective|budget)\b/.test(normalized)) return "schedule";
  if (/\b(project|workspace|documentation|docs directory|newsletters|research)\b/.test(normalized)) return "project";
  if (/\b(workflow|review|refactor|summary|pull request|code review|task tracker)\b/.test(normalized)) return "workflow";
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
