// ============================================================================
// Core Admission Gate: LLM-based judgment for capture candidates
// Called from CandidateQueue processor for items the regex didn't catch.
// Uses OpenAI-compatible chat completions API (works with Gemini, DeepSeek, etc.)
// ============================================================================

import type { LlmGateConfig } from "./types.js";
import { sanitizeJsonLikeResponse } from "./backends/free-text/mem0.js";
import { buildKimiMessagesUrl, isKimiCodingBaseUrl, normalizeChatApiConfig } from "./llm-config.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

export type AdmissionResult = {
  index: number;
  verdict: "core" | "free_text" | "discard";
  key?: string;
  value?: string;
  reason?: string;
};

const SYSTEM_PROMPT = `你是记忆管理系统的评审员。判断用户消息是否包含值得长期记忆的事实。

对于每条消息，判断类别：
- core: 用户的稳定个人特征（身份/偏好/目标/关系/约束/工作背景/技能/习惯）
- free_text: 有价值的上下文信息（技术决策/工作进展/经验教训/项目信息/架构选择）
- discard: 低信号/临时性/纯指令/闲聊内容

规则：
1. 每条消息只输出一个判断
2. core 类型必须提供 key（格式: category.topic，如 identity.name, work.company, preferences.editor）和 value
3. free_text 类型可选提供 value（简洁摘要）
4. discard 类型可以省略不输出
5. 只返回 JSON 数组，不要包含其他文字

Value格式要求：
- 不要使用"用户"作为主语
- 不要重复 key 的语义（如 key 是 name，不要写"名字是..."）
- 直接陈述事实，简洁明了
- 示例：key=identity.name → value="昊，北京，UTC+8"（而不是"用户叫昊，常驻北京..."）
- 示例：key=preferences.editor → value="VSCode + Vim 模式"（而不是"用户偏好使用 VSCode..."）

返回格式: [{"index": 1, "verdict": "core", "key": "identity.name", "value": "昊", "reason": "稳定身份信息"}]`;

export function buildUserPrompt(texts: string[]): string {
  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `消息列表:\n${numbered}`;
}

export function parseAdmissionResponse(raw: unknown): AdmissionResult[] {
  const sanitized = sanitizeJsonLikeResponse(raw);
  let parsed: unknown;
  try {
    parsed = typeof sanitized === "string" ? JSON.parse(sanitized) : sanitized;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const results: AdmissionResult[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    const index = typeof obj.index === "number" ? obj.index : NaN;
    const verdict = obj.verdict;
    if (!Number.isFinite(index) || index < 1) continue;
    if (verdict !== "core" && verdict !== "free_text" && verdict !== "discard") continue;

    results.push({
      index,
      verdict,
      key: typeof obj.key === "string" ? obj.key : undefined,
      value: typeof obj.value === "string" ? obj.value : undefined,
      reason: typeof obj.reason === "string" ? obj.reason : undefined,
    });
  }

  return results;
}

export async function judgeCandidates(
  texts: string[],
  config: LlmGateConfig,
  logger: Logger,
): Promise<AdmissionResult[]> {
  if (texts.length === 0) {
    logger.info("llm-gate: empty input, returning []");
    return [];
  }

  const apiKey = config.apiKey;
  logger.info(`llm-gate: apiKey present=${!!apiKey}, apiBase=${config.apiBase}, model=${config.model}`);

  if (!apiKey) {
    logger.info("llm-gate: skipped (no API key)");
    return [];
  }

  const { apiBase, model } = normalizeChatApiConfig({
    apiBase: config.apiBase,
    model: config.model,
  });
  const isKimi = isKimiCodingBaseUrl(apiBase);
  const url = isKimi
    ? buildKimiMessagesUrl(apiBase)
    : `${apiBase.replace(/\/+$/, "")}/chat/completions`;

  const body = isKimi
    ? {
        model,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: buildUserPrompt(texts) },
        ],
        max_tokens: config.maxTokensPerBatch,
        temperature: 0.1,
      }
    : {
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(texts) },
        ],
        max_tokens: config.maxTokensPerBatch,
        temperature: 0.1,
      };

  logger.info(`llm-gate: calling API, url=${url}, model=${model}, texts count=${texts.length}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(isKimi
          ? {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "User-Agent": "claude-code/0.1.0",
            }
          : {
              Authorization: `Bearer ${apiKey}`,
            }),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logger.warn(`llm-gate: HTTP ${resp.status} — ${text.slice(0, 200)}`);
      return [];
    }

    const json = (await resp.json()) as Record<string, unknown>;
    const content = isKimi
      ? Array.isArray(json.content)
        ? json.content
          .filter((block): block is { type?: string; text?: string } => !!block && typeof block === "object")
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("")
        : undefined
      : (json.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]?.message?.content;

    if (!content) {
      logger.warn("llm-gate: empty response content");
      return [];
    }

    logger.info(`llm-gate: raw response length=${content.length}`);
    logger.info(`llm-gate: raw response preview="${content.slice(0, 200)}${content.length > 200 ? '...' : ''}"`);

    const results = parseAdmissionResponse(content);
    logger.info(`llm-gate: parsed ${results.length} results`);

    for (const r of results) {
      logger.info(`llm-gate: result index=${r.index} verdict=${r.verdict}${r.key ? ` key=${r.key}` : ''}${r.reason ? ` reason="${r.reason}"` : ''}`);
    }

    logger.info(`llm-gate: judged ${texts.length} candidates → ${results.length} actionable results`);
    return results;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      logger.warn(`llm-gate: timeout after ${config.timeoutMs}ms`);
    } else {
      logger.warn(`llm-gate: error — ${String(err)}`);
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}
