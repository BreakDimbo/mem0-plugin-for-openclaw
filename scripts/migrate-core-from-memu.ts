import { readFile } from "node:fs/promises";

import { MemUClient } from "../client.js";
import { CoreMemoryRepository } from "../core-repository.js";
import { loadConfig } from "../types.js";

type AgentScope = {
  userId: string;
  agentId: string;
  sessionKey: string;
};

async function main() {
  const raw = JSON.parse(await readFile("~/.openclaw/openclaw.json", "utf-8"));
  const config = loadConfig(raw?.plugins?.entries?.["memory-memu"]?.config ?? {});
  const logger = { info: console.log, warn: console.warn };
  const client = new MemUClient(
    config.memu.baseUrl,
    config.memu.timeoutMs,
    config.memu.cbResetMs,
    config.memu.healthCheckPath,
    logger,
  );
  const repo = new CoreMemoryRepository(config.core.persistPath, logger, config.core.maxItemChars);
  const scopes = collectScopes(config);

  const results: Array<{ agentId: string; imported: number }> = [];
  for (const scope of scopes) {
    const res = await client.coreList({
      userId: scope.userId,
      agentId: scope.agentId,
      limit: 500,
    });
    if (res.status !== "success" || !Array.isArray(res.items) || res.items.length === 0) {
      results.push({ agentId: scope.agentId, imported: 0 });
      continue;
    }

    const ok = await repo.upsertMany(
      scope,
      res.items
        .map((item) => {
          const rawItem = item as Record<string, unknown>;
          return {
            category: String(rawItem.category ?? "general"),
            key: String(rawItem.key ?? ""),
            value: String(rawItem.value ?? ""),
            importance: typeof rawItem.importance === "number" ? rawItem.importance : undefined,
            provenance:
              typeof rawItem.source === "string"
                ? rawItem.source
                : typeof rawItem.provenance === "string"
                  ? rawItem.provenance
                  : "memu-migration",
          };
        })
        .filter((item) => item.key.trim() && item.value.trim()),
    );
    results.push({ agentId: scope.agentId, imported: ok ? res.items.length : 0 });
  }

  console.log(JSON.stringify({ migratedAt: new Date().toISOString(), results }, null, 2));
}

function collectScopes(config: ReturnType<typeof loadConfig>): AgentScope[] {
  const pairs = new Map<string, AgentScope>();
  const defaultScope = {
    userId: config.scope.userId,
    agentId: config.scope.agentId,
    sessionKey: `agent:${config.scope.agentId}:main`,
  };
  pairs.set(`${defaultScope.userId}::${defaultScope.agentId}`, defaultScope);

  for (const [agentId, userId] of Object.entries(config.scope.userIdByAgent ?? {})) {
    const scope = {
      userId,
      agentId,
      sessionKey: `agent:${agentId}:main`,
    };
    pairs.set(`${userId}::${agentId}`, scope);
  }
  return Array.from(pairs.values());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
