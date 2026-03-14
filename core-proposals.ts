import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { CoreMemoryProposal, MemoryScope } from "./types.js";
import { normalizeCoreCategory } from "./core-repository.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

type ProposalStatus = CoreMemoryProposal["status"];

export type ProposalDraft = {
  category: string;
  text: string;
  key: string;
  value: string;
  reason: string;
  scope: MemoryScope;
};

export class CoreProposalQueue {
  private proposals: CoreMemoryProposal[] = [];
  private readonly maxSize: number;
  private readonly persistPath: string;
  private readonly logger: Logger;

  constructor(persistPath: string, maxSize: number, logger: Logger) {
    this.persistPath = persistPath.replace(/^~/, homedir());
    this.maxSize = maxSize;
    this.logger = logger;
  }

  get pendingCount(): number {
    return this.proposals.filter((p) => p.status === "pending").length;
  }

  get size(): number {
    return this.proposals.length;
  }

  private get filePath(): string {
    return this.persistPath ? `${this.persistPath}/core-proposals.json` : "";
  }

  private async saveToDisk(): Promise<void> {
    if (!this.filePath) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.proposals, null, 2), "utf-8");
    } catch (err) {
      this.logger.warn(`core-proposals: failed to persist queue: ${String(err)}`);
    }
  }

  async loadFromDisk(): Promise<void> {
    if (!this.filePath) return;
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.proposals = parsed.filter((p) => p && typeof p === "object") as CoreMemoryProposal[];
      }
    } catch {
      // missing file is expected on first run
    }
  }

  async start(): Promise<void> {
    await this.loadFromDisk();
    this.logger.info(`core-proposals: loaded ${this.proposals.length} proposal(s)`);
  }

  async stop(): Promise<void> {
    await this.saveToDisk();
  }

  enqueue(draft: ProposalDraft): CoreMemoryProposal {
    const candidateText = draft.text.trim();
    const candidateKey = draft.key.trim().toLowerCase();
    const candidateValue = draft.value.trim();
    if (!candidateText || !candidateKey || !candidateValue) {
      throw new Error("invalid core proposal draft");
    }

    const dupe = this.proposals.find(
      (p) =>
        p.status === "pending" &&
        p.scope.userId === draft.scope.userId &&
        p.scope.agentId === draft.scope.agentId &&
        p.key === candidateKey &&
        p.value === candidateValue,
    );
    if (dupe) return dupe;

    const proposal: CoreMemoryProposal = {
      id: randomUUID(),
      category: normalizeCoreCategory(draft.category, candidateKey),
      text: candidateText,
      key: candidateKey,
      value: candidateValue,
      reason: draft.reason.trim() || "captured from user message",
      scope: draft.scope,
      createdAt: Date.now(),
      status: "pending",
    };
    this.proposals.push(proposal);
    if (this.proposals.length > this.maxSize) {
      this.proposals.splice(0, this.proposals.length - this.maxSize);
    }
    this.saveToDisk().catch(() => {});
    return proposal;
  }

  list(status: ProposalStatus | "all" = "pending", limit = 20): CoreMemoryProposal[] {
    const filtered = status === "all" ? this.proposals : this.proposals.filter((p) => p.status === status);
    return filtered.slice(-Math.max(1, limit)).reverse();
  }

  listForScope(scope: MemoryScope, status: ProposalStatus | "all" = "pending", limit = 20): CoreMemoryProposal[] {
    const filtered = this.proposals.filter(
      (p) =>
        p.scope.userId === scope.userId &&
        p.scope.agentId === scope.agentId &&
        (status === "all" || p.status === status),
    );
    return filtered.slice(-Math.max(1, limit)).reverse();
  }

  approve(id: string, reviewer = "human"): CoreMemoryProposal | null {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal || proposal.status !== "pending") return null;
    proposal.status = "approved";
    proposal.reviewedAt = Date.now();
    proposal.reviewer = reviewer;
    this.saveToDisk().catch(() => {});
    return proposal;
  }

  approveForScope(id: string, scope: MemoryScope, reviewer = "human"): CoreMemoryProposal | null {
    const proposal = this.proposals.find(
      (p) =>
        p.id === id &&
        p.status === "pending" &&
        p.scope.userId === scope.userId &&
        p.scope.agentId === scope.agentId,
    );
    if (!proposal) return null;
    proposal.status = "approved";
    proposal.reviewedAt = Date.now();
    proposal.reviewer = reviewer;
    this.saveToDisk().catch(() => {});
    return proposal;
  }

  reject(id: string, reviewer = "human"): CoreMemoryProposal | null {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal || proposal.status !== "pending") return null;
    proposal.status = "rejected";
    proposal.reviewedAt = Date.now();
    proposal.reviewer = reviewer;
    this.saveToDisk().catch(() => {});
    return proposal;
  }

  rejectForScope(id: string, scope: MemoryScope, reviewer = "human"): CoreMemoryProposal | null {
    const proposal = this.proposals.find(
      (p) =>
        p.id === id &&
        p.status === "pending" &&
        p.scope.userId === scope.userId &&
        p.scope.agentId === scope.agentId,
    );
    if (!proposal) return null;
    proposal.status = "rejected";
    proposal.reviewedAt = Date.now();
    proposal.reviewer = reviewer;
    this.saveToDisk().catch(() => {});
    return proposal;
  }
}

function sanitizeKeyPart(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function stableKeySuffix(raw: string): string {
  const ascii = sanitizeKeyPart(raw);
  if (ascii) return ascii;
  return `fact_${createHash("sha1").update(raw).digest("hex").slice(0, 10)}`;
}

function isMeaningfulCoreValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 2) return true;
  const cjkCount = (trimmed.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (cjkCount >= 4) return true;
  if (/^[a-z0-9_:+./-]{4,}$/i.test(trimmed)) return true;
  return trimmed.length >= 6;
}

export function extractCoreProposal(text: string, scope: MemoryScope): ProposalDraft | null {
  const msg = text.trim().replace(/\s+/g, " ");
  if (msg.length < 8 || msg.length > 500) return null;

  const normalized = msg.toLowerCase();

  // Core memory should only capture durable profile-like facts.
  // Keep short-lived tasks, test chatter, and near-term plans in long-term
  // free-text memory instead of elevating them into structured core memory.
  const transientPatterns = [
    /\b(today|tomorrow|tonight|this morning|this afternoon|this evening|next week)\b/i,
    /\b明天\b|\b今天\b|\b今晚\b|\b下周\b/,
    /\btest(ing)?\b|\bdebug\b|\boutbox\b|\bmemu\b/i,
    /测试|调试|联调|修复/,
    /\bplan(?:ning)?\b/i,
    /计划于/,
    /\bwill\b/i,
  ];
  if (transientPatterns.some((pattern) => pattern.test(msg))) {
    return null;
  }

  const patterns: Array<{ rx: RegExp; category: string; keyPrefix: string; reason: string }> = [
    { rx: /^my name is (.+)$/i, category: "identity", keyPrefix: "identity.name", reason: "user identity statement" },
    { rx: /^i (?:prefer|like|usually prefer) (.+)$/i, category: "preferences", keyPrefix: "preferences", reason: "user preference statement" },
    { rx: /^i(?:'m| am) from (.+)$/i, category: "identity", keyPrefix: "identity.location", reason: "user profile statement" },
    { rx: /^i(?:'m| am) based in (.+)$/i, category: "identity", keyPrefix: "identity.location", reason: "user profile statement" },
    { rx: /^my timezone is (.+)$/i, category: "identity", keyPrefix: "identity.timezone", reason: "user profile statement" },
    { rx: /^i work (?:on|with) (.+)$/i, category: "constraints", keyPrefix: "constraints.work", reason: "user long-term work context" },
    { rx: /^we (?:use|are using|always use) (.+)$/i, category: "constraints", keyPrefix: "team.stack", reason: "team/project persistent detail" },
    { rx: /^we do not use (.+)$/i, category: "constraints", keyPrefix: "constraints.avoid", reason: "team/project persistent constraint" },
    { rx: /^our standard is (.+)$/i, category: "constraints", keyPrefix: "constraints.standard", reason: "team/project persistent standard" },
    { rx: /^i always want (.+)$/i, category: "preferences", keyPrefix: "preferences", reason: "stable user preference statement" },
    { rx: /^i never want (.+)$/i, category: "preferences", keyPrefix: "preferences.avoid", reason: "stable user preference statement" },
    { rx: /^my long-term goal is (.+)$/i, category: "goals", keyPrefix: "goals.primary", reason: "user long-term goal statement" },
    { rx: /^one of my goals is (.+)$/i, category: "goals", keyPrefix: "goals.secondary", reason: "user long-term goal statement" },
    { rx: /^我叫(.+)$/i, category: "identity", keyPrefix: "identity.name", reason: "user identity statement" },
    { rx: /^我的名字是(.+)$/i, category: "identity", keyPrefix: "identity.name", reason: "user identity statement" },
    { rx: /^我的时区是(.+)$/i, category: "identity", keyPrefix: "identity.timezone", reason: "user profile statement" },
    { rx: /^我在(.+)工作$/i, category: "identity", keyPrefix: "identity.workplace", reason: "user profile statement" },
    { rx: /^我目前的职业是(.+)$/i, category: "identity", keyPrefix: "identity.current_role", reason: "user profile statement" },
    { rx: /^我现在的职业是(.+)$/i, category: "identity", keyPrefix: "identity.current_role", reason: "user profile statement" },
    { rx: /^我(更)?喜欢(.+)$/i, category: "preferences", keyPrefix: "preferences", reason: "user preference statement" },
    { rx: /^我偏好(.+)$/i, category: "preferences", keyPrefix: "preferences", reason: "user preference statement" },
    { rx: /^我不喜欢(.+)$/i, category: "preferences", keyPrefix: "preferences.avoid", reason: "stable user preference statement" },
    { rx: /^我讨厌(.+)$/i, category: "preferences", keyPrefix: "preferences.avoid", reason: "stable user preference statement" },
    { rx: /^我的长期目标是(.+)$/i, category: "goals", keyPrefix: "goals.primary", reason: "user long-term goal statement" },
    { rx: /^我的目标是(.+)$/i, category: "goals", keyPrefix: "goals.primary", reason: "user long-term goal statement" },
    { rx: /^我的主目标是(.+)$/i, category: "goals", keyPrefix: "goals.primary", reason: "user long-term goal statement" },
    { rx: /^我通常在(.+)最高效$/i, category: "preferences", keyPrefix: "preferences.peak_hours", reason: "stable user preference statement" },
    { rx: /^我偏好(.+)沟通$/i, category: "preferences", keyPrefix: "preferences.communication_mode", reason: "stable user preference statement" },
    { rx: /^我们(一直)?使用(.+)$/i, category: "constraints", keyPrefix: "constraints.standard", reason: "team/project persistent detail" },
    { rx: /^我们不用(.+)$/i, category: "constraints", keyPrefix: "constraints.avoid", reason: "team/project persistent constraint" },
    { rx: /^我们的标准是(.+)$/i, category: "constraints", keyPrefix: "constraints.standard", reason: "team/project persistent standard" },
  ];

  for (const p of patterns) {
    const m = msg.match(p.rx);
    if (!m) continue;
    const rawValue = (m[2] ?? m[1] ?? "").trim();
    if (!rawValue) continue;
    const value = rawValue.replace(/[.。!?]+$/, "").slice(0, 220);
    if (!value) continue;
    if (!isMeaningfulCoreValue(value)) continue;
    const suffix = stableKeySuffix(value.split(/[,:;，：；。]/)[0] ?? "fact");
    const key = `${p.keyPrefix}${suffix ? `.${suffix}` : ""}`.slice(0, 80);
    return {
      category: p.category,
      text: msg,
      key,
      value,
      reason: p.reason,
      scope,
    };
  }

  return null;
}
