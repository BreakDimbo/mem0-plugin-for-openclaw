import { randomUUID } from "node:crypto";
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

  reject(id: string, reviewer = "human"): CoreMemoryProposal | null {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal || proposal.status !== "pending") return null;
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

export function extractCoreProposal(text: string, scope: MemoryScope): ProposalDraft | null {
  const msg = text.trim().replace(/\s+/g, " ");
  if (msg.length < 8 || msg.length > 500) return null;

  const patterns: Array<{ rx: RegExp; category: string; keyPrefix: string; reason: string }> = [
    { rx: /^my name is (.+)$/i, category: "identity", keyPrefix: "identity.name", reason: "user identity statement" },
    { rx: /^i (?:prefer|like) (.+)$/i, category: "preferences", keyPrefix: "preferences", reason: "user preference statement" },
    { rx: /^i(?:'m| am) from (.+)$/i, category: "identity", keyPrefix: "identity.location", reason: "user profile statement" },
    { rx: /^(?:please )?remember (?:that )?(.+)$/i, category: "general", keyPrefix: "remember", reason: "explicit remember request" },
    { rx: /^we (?:use|are using) (.+)$/i, category: "constraints", keyPrefix: "team.stack", reason: "team/project persistent detail" },
  ];

  for (const p of patterns) {
    const m = msg.match(p.rx);
    if (!m?.[1]) continue;
    const value = m[1].trim().replace(/[.。!?]+$/, "").slice(0, 220);
    if (!value) continue;
    const suffix = sanitizeKeyPart(value.split(/[,:;]/)[0] ?? "fact");
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
