import type { MemUAdapter } from "../../adapter.js";
import type { MemuPluginConfig } from "../../types.js";
import type { MemUClient } from "../../client.js";
import { Mem0FreeTextBackend } from "./mem0.js";
import { MemUFreeTextBackend } from "./memu.js";
import type { FreeTextBackend } from "./base.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

export function createPrimaryFreeTextBackend(
  config: MemuPluginConfig,
  deps: { adapter?: MemUAdapter | null; client?: MemUClient | null; logger: Logger },
): FreeTextBackend {
  if (config.backend.freeText.provider === "mem0") {
    return new Mem0FreeTextBackend(config, deps.logger);
  }
  if (!deps.adapter || !deps.client) {
    throw new Error("memU free-text backend requires MemU adapter and client");
  }
  return new MemUFreeTextBackend(deps.adapter, () => deps.client.healthCheck());
}

export function createMemuFallbackBackend(
  deps: { adapter?: MemUAdapter | null; client?: MemUClient | null },
): FreeTextBackend {
  if (!deps.adapter || !deps.client) {
    throw new Error("memU fallback backend requires MemU adapter and client");
  }
  return new MemUFreeTextBackend(deps.adapter, () => deps.client.healthCheck());
}
