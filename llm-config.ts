const KIMI_CODING_PROVIDER = "kimi-coding";
const MEM0_KIMI_CODING_PROVIDER = "kimi_coding";
const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/";
const KIMI_CODING_DEFAULT_MODEL = "k2p5";
const KIMI_CODING_DEFAULT_REASONING_MODEL = "k2p5-thinking";

type Mem0LlmConfig = {
  provider: string;
  config: Record<string, unknown>;
};

export type ChatApiConfig = {
  apiBase?: string;
  model?: string;
};

export function getKimiCodingBaseUrl(): string {
  return KIMI_CODING_BASE_URL;
}

export function getKimiCodingDefaultModel(): string {
  return KIMI_CODING_DEFAULT_MODEL;
}

export function getKimiCodingDefaultReasoningModel(): string {
  return KIMI_CODING_DEFAULT_REASONING_MODEL;
}

export function normalizeProviderName(provider: string | undefined): string {
  return String(provider ?? "").trim().toLowerCase();
}

export function isGoogleProvider(provider: string | undefined): boolean {
  const normalized = normalizeProviderName(provider);
  return normalized === "google" || normalized === "gemini";
}

export function isKimiCodingProvider(provider: string | undefined): boolean {
  const normalized = normalizeProviderName(provider);
  return normalized === KIMI_CODING_PROVIDER || normalized === MEM0_KIMI_CODING_PROVIDER;
}

export function isKimiCodingBaseUrl(apiBase: string | undefined): boolean {
  if (typeof apiBase !== "string") return false;
  return apiBase.replace(/\/+$/, "") === KIMI_CODING_BASE_URL.replace(/\/+$/, "");
}

export function buildKimiMessagesUrl(apiBase: string | undefined): string {
  const base = isKimiCodingBaseUrl(apiBase) ? KIMI_CODING_BASE_URL : (apiBase || KIMI_CODING_BASE_URL);
  return `${base.replace(/\/+$/, "")}/v1/messages`;
}

export function stripProviderPrefix(model: string | undefined): string | undefined {
  if (typeof model !== "string") return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const [, rest] = trimmed.split("/", 2);
  return trimmed.includes("/") && rest ? rest : trimmed;
}

export function normalizeChatApiConfig(config: ChatApiConfig): Required<ChatApiConfig> {
  const strippedModel = stripProviderPrefix(config.model);
  const isKimiModel = typeof config.model === "string" && config.model.trim().startsWith(`${KIMI_CODING_PROVIDER}/`);
  const apiBase = isKimiModel || isKimiCodingBaseUrl(config.apiBase)
    ? KIMI_CODING_BASE_URL
    : (typeof config.apiBase === "string" && config.apiBase.trim()) ? config.apiBase : KIMI_CODING_BASE_URL;
  return {
    apiBase,
    model: strippedModel || KIMI_CODING_DEFAULT_MODEL,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function normalizeMem0LlmConfig(raw: Mem0LlmConfig | undefined, fallbackApiKey?: string): Mem0LlmConfig | undefined {
  if (!raw) return undefined;

  const sourceConfig = toRecord(raw.config);
  const apiKey = typeof sourceConfig.apiKey === "string" && sourceConfig.apiKey.trim().length > 0
    ? sourceConfig.apiKey
    : fallbackApiKey;

  if (isKimiCodingProvider(raw.provider)) {
    return {
      provider: MEM0_KIMI_CODING_PROVIDER,
      config: {
        ...sourceConfig,
        ...(apiKey ? { apiKey } : {}),
        model: stripProviderPrefix(sourceConfig.model as string | undefined) || KIMI_CODING_DEFAULT_MODEL,
        kimi_coding_base_url: typeof sourceConfig.kimi_coding_base_url === "string" && sourceConfig.kimi_coding_base_url.trim().length > 0
          ? sourceConfig.kimi_coding_base_url
          : KIMI_CODING_BASE_URL,
      },
    };
  }

  if (normalizeProviderName(raw.provider) === "openai" && (
    isKimiCodingBaseUrl(sourceConfig.baseURL as string | undefined) ||
    typeof sourceConfig.model === "string")
  ) {
    const normalized = normalizeChatApiConfig({
      apiBase: sourceConfig.baseURL as string | undefined,
      model: sourceConfig.model as string | undefined,
    });
    return {
      provider: raw.provider,
      config: {
        ...sourceConfig,
        ...(apiKey ? { apiKey } : {}),
        baseURL: normalized.apiBase,
        model: normalized.model,
      },
    };
  }

  if (!sourceConfig.apiKey && apiKey) {
    return {
      provider: raw.provider,
      config: {
        ...sourceConfig,
        apiKey,
      },
    };
  }

  return {
    provider: raw.provider,
    config: sourceConfig,
  };
}
