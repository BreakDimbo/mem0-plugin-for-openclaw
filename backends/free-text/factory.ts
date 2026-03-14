import type { MemuPluginConfig } from "../../types.js";
import { Mem0FreeTextBackend } from "./mem0.js";
import type { FreeTextBackend } from "./base.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

export function createPrimaryFreeTextBackend(
  config: MemuPluginConfig,
  deps: { logger: Logger },
): FreeTextBackend {
  return new Mem0FreeTextBackend(config, deps.logger);
}
