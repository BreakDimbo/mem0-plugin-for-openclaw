// ============================================================================
// Core Admission Gate: LLM-based judgment for capture candidates
// Called from CandidateQueue processor for items the regex didn't catch.
// Uses OpenAI-compatible chat completions API (works with Gemini, DeepSeek, etc.)
// ============================================================================

import type { LlmGateConfig, ClassificationResult, CaptureHint } from "./types.js";
import { sanitizeJsonLikeResponse } from "./backends/free-text/mem0.js";
import { isKimiCodingBaseUrl, isLocalOllamaBaseUrl, normalizeChatApiConfig } from "./llm-config.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

export type AdmissionResult = {
  index: number;
  verdict: "core" | "free_text" | "discard";
  key?: string;
  value?: string;
  reason?: string;
};

const SYSTEM_PROMPT = `你是记忆管理系统的评审员。判断用户消息是否包含值得长期记忆的事实。

输入格式说明：每条消息可能包含前置对话轮次（以 [assistant]/[user] 标记），用于提供上下文。判断目标始终是最后一条 [user] 消息；前置轮次仅作辅助理解，不单独判断。

对于每条消息，判断类别：
- core: 用户的稳定个人特征（身份/偏好/目标/关系/约束/工作背景/技能/习惯）
- free_text: 在未来多次对话中仍有参考价值的信息（用户偏好、项目背景、技术架构决策、经过验证的方法论）。不包括本次会话独有的临时信息。
- discard: 低信号/临时性/纯指令/闲聊内容

必须判为 discard 的情况（即使内容看似重要）：
- Bug 报告、错误描述、调试过程记录（如 "某功能有 bug"、"statistics remain 0"）
- 负面发现或"未找到信息"类表述（如 "no information confirming X"、"未发现相关记录"）
- 仅在当前会话或当天有效的临时事件（如 "今天重启了服务"、"本次会话已处理"）
- 包含明显拼写错误或混乱的内容（如 "opencalw" 而非 "openclaw"）
- 纯粹的工具调用结果或系统状态输出
- 代码片段、堆栈追踪、日志输出

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

/**
 * Build a context-enriched text string for a candidate message.
 * Includes up to `maxContextTurns` preceding user/assistant turns
 * so the LLM gate can judge ambiguous messages with surrounding context.
 * Returns plain lastUserContent when no preceding turns are available.
 */
export function buildCandidateContextText(
  messages: Array<{ role: string; content: string }>,
  maxContextTurns = 2,
): string {
  let lastUserIdx = -1;
  for (let j = messages.length - 1; j >= 0; j--) {
    if (messages[j].role === "user") { lastUserIdx = j; break; }
  }
  if (lastUserIdx < 0) return "";

  const parts: string[] = [];
  let turns = 0;
  for (let j = lastUserIdx - 1; j >= 0 && turns < maxContextTurns; j--) {
    const m = messages[j];
    if (m.role === "user" || m.role === "assistant") {
      parts.unshift(`[${m.role}] ${m.content.slice(0, 300)}`);
      turns++;
    }
  }
  if (parts.length > 0) {
    parts.push(`[user] ${messages[lastUserIdx].content}`);
    return parts.join("\n");
  }
  return messages[lastUserIdx].content;
}

/**
 * Resolve capture routing flags from the classifier result.
 *
 * skipCapture — skip free-text AND core extraction entirely
 *   triggers on: greeting queryType, or captureHint="skip"
 *
 * skipLlmGate — write to free-text outbox directly, bypass core LLM judgment
 *   triggers on: skipCapture=true, or captureHint="light"
 */
export function resolveCaptureRouting(classification: ClassificationResult | undefined): {
  skipCapture: boolean;
  skipLlmGate: boolean;
} {
  const skipCapture = !!classification &&
    (classification.queryType === "greeting" || classification.captureHint === "skip");
  const skipLlmGate = skipCapture ||
    (!!classification && (classification.captureHint as CaptureHint) === "light");
  return { skipCapture, skipLlmGate };
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

// Module-level inflight map: prevents duplicate LLM calls for identical candidate batches
// when multiple hook instances fire concurrently (multi-process plugin registration).
const JUDGE_INFLIGHT = new Map<string, Promise<AdmissionResult[]>>();

export async function judgeCandidates(
  texts: string[],
  config: LlmGateConfig,
  logger: Logger,
): Promise<AdmissionResult[]> {
  if (texts.length === 0) {
    logger.info("llm-gate: empty input, returning []");
    return [];
  }

  const inflightKey = texts.join("\x00");
  const existing = JUDGE_INFLIGHT.get(inflightKey);
  if (existing) {
    logger.info("llm-gate: dedup inflight request for same candidate batch");
    return existing;
  }

  const promise = (async () => { try {
  const apiKey = config.apiKey;
  logger.info(`llm-gate: apiKey present=${!!apiKey}, apiBase=${config.apiBase}, model=${config.model}`);

  const { apiBase, model } = normalizeChatApiConfig({
    apiBase: config.apiBase,
    model: config.model,
  });
  const isKimi = isKimiCodingBaseUrl(apiBase);
  const isLocalOllama = isLocalOllamaBaseUrl(apiBase);

  if (!apiKey && !isLocalOllama) {
    logger.info("llm-gate: skipped (no API key)");
    return [];
  }

  const url = `${apiBase.replace(/\/+$/, "")}/chat/completions`;

  const body = {
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
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(isKimi ? { "User-Agent": "claude-code/0.1.0" } : {}),
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
    const content = (json.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]?.message?.content;

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
  } finally {
    JUDGE_INFLIGHT.delete(inflightKey);
  }
  })();

  JUDGE_INFLIGHT.set(inflightKey, promise);
  return promise;
}
