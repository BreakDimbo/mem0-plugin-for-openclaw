import type { CoreMemoryRepository } from "../core-repository.js";
import type { CoreProposalQueue } from "../core-proposals.js";

export function createCoreProposalTool(
  queue: CoreProposalQueue,
  repo: CoreMemoryRepository,
) {
  return {
    name: "memory_core_proposals",
    description: "Review core memory proposals. Actions: list, approve, reject.",
    parameters: {
      type: "object" as const,
      properties: {
        action: { type: "string" as const, description: "list | approve | reject" },
        proposalId: { type: "string" as const, description: "Proposal id for approve/reject" },
        limit: { type: "number" as const, description: "Result limit for list" },
      },
      required: ["action"] as const,
    },
    execute: async (_id: string, args: { action: "list" | "approve" | "reject"; proposalId?: string; limit?: number }) => {
      const action = args.action ?? "list";
      if (action === "list") {
        const entries = queue.list("pending", args.limit ?? 20);
        if (entries.length === 0) return { text: "No pending core proposals." };
        return { text: entries.map((p) => `- ${p.id} [${p.key}] ${p.value} (${p.reason})`).join("\n") };
      }

      if (!args.proposalId) return { text: "proposalId is required for approve/reject." };
      if (action === "approve") {
        const proposal = queue.approve(args.proposalId, "tool");
        if (!proposal) return { text: "Proposal not found or already reviewed." };
        const category = proposal.key.split(".")[0] || "general";
        const ok = await repo.upsert(proposal.scope, {
          category,
          key: proposal.key,
          value: proposal.value,
          source: "proposal-approved",
          metadata: { proposal_id: proposal.id, reason: proposal.reason },
        });
        return { text: ok ? `Proposal approved and upserted: ${proposal.id}` : `Proposal approved but upsert failed: ${proposal.id}` };
      }

      const rejected = queue.reject(args.proposalId, "tool");
      return { text: rejected ? `Proposal rejected: ${rejected.id}` : "Proposal not found or already reviewed." };
    },
  };
}
