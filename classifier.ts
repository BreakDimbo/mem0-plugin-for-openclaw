// ============================================================================
// UnifiedIntentClassifier: Single LLM call to classify query intent
// Used for: recall filtering, capture skip logic, injection optimization
// ============================================================================

import { LRUCache } from "./cache.js";
import { buildKimiMessagesUrl, isKimiCodingBaseUrl, normalizeChatApiConfig } from "./llm-config.js";
import type { ClassificationResult, ClassifierConfig, QueryType, CaptureHint } from "./types.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

type ClassifierMetrics = {
  classifierCalls: number;
  classifierHits: number;
  classifierErrors: number;
};

const DEFAULT_RESULT: ClassificationResult = {
  tier: "MEDIUM",
  queryType: "open",
  targetCategories: [],
  captureHint: "full",
};

const SYSTEM_PROMPT = `你是意图分类器。分析用户消息，返回JSON对象（不要markdown代码块）。

tier: SIMPLE(问候/感谢) | MEDIUM(单步查询) | COMPLEX(多步推理) | REASONING(深度思考)
queryType: greeting | code | debug | factual | preference | planning | open
targetCategories: identity/work/preferences/goals/constraints/relationships/technical/general
captureHint: skip(不记忆) | light(仅free_text) | full(完整处理)

直接返回JSON: {"tier":"MEDIUM","queryType":"factual","targetCategories":["identity"],"captureHint":"full"}`;

function buildUserPrompt(query: string): string {
  return `用户消息: ${query.slice(0, 500)}`;
}

function parseClassificationResponse(raw: unknown): ClassificationResult | null {
  let text = typeof raw === "string" ? raw : "";
  if (!text) return null;

  // Extract JSON from markdown code blocks if present (handle both complete and incomplete blocks)
  const fencedComplete = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedComplete?.[1]) {
    text = fencedComplete[1];
  } else {
    // Handle incomplete code block (no closing ```)
    const fencedIncomplete = text.match(/```(?:json)?\s*([\s\S]*)/i);
    if (fencedIncomplete?.[1]) text = fencedIncomplete[1];
  }

  // Find JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  // Try to parse complete JSON first
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const result = validateAndBuildResult(parsed);
      if (result) return result;
    } catch {
      // Fall through to fallback parsing
    }
  }

  // Fallback: try to extract partial values from truncated response
  return parsePartialResponse(text);
}

function validateAndBuildResult(parsed: Record<string, unknown>): ClassificationResult | null {
  const tier = parsed.tier;
  const queryType = parsed.queryType;
  const targetCategories = parsed.targetCategories;
  const captureHint = parsed.captureHint;

  // Validate tier
  if (!["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"].includes(tier as string)) {
    return null;
  }

  // Validate queryType
  const validQueryTypes: QueryType[] = ["greeting", "code", "debug", "factual", "preference", "planning", "open"];
  if (!validQueryTypes.includes(queryType as QueryType)) {
    return null;
  }

  // Validate captureHint
  const validCaptureHints: CaptureHint[] = ["skip", "light", "full"];
  if (!validCaptureHints.includes(captureHint as CaptureHint)) {
    return null;
  }

  // Parse targetCategories
  const categories: string[] = [];
  if (Array.isArray(targetCategories)) {
    for (const cat of targetCategories) {
      if (typeof cat === "string") categories.push(cat);
    }
  }

  return {
    tier: tier as ClassificationResult["tier"],
    queryType: queryType as QueryType,
    targetCategories: categories,
    captureHint: captureHint as CaptureHint,
  };
}

// Fallback parser for truncated responses - extract what we can
function parsePartialResponse(text: string): ClassificationResult | null {
  // Try to extract tier from partial text like `"tier": "COMP` or `"tier":"COMPLEX`
  const tierMatch = text.match(/"tier"\s*:\s*"(SIMPLE|MEDIUM|COMPLEX|REASONING)/i);
  if (!tierMatch) return null;

  const tier = tierMatch[1].toUpperCase() as ClassificationResult["tier"];

  // Try to extract queryType
  const queryTypeMatch = text.match(/"queryType"\s*:\s*"(greeting|code|debug|factual|preference|planning|open)/i);
  const queryType = (queryTypeMatch?.[1]?.toLowerCase() || "open") as QueryType;

  // Try to extract captureHint
  const captureHintMatch = text.match(/"captureHint"\s*:\s*"(skip|light|full)/i);
  const captureHint = (captureHintMatch?.[1]?.toLowerCase() || "full") as CaptureHint;

  // targetCategories is optional, default to empty
  return {
    tier,
    queryType,
    targetCategories: [],
    captureHint,
  };
}

export class UnifiedIntentClassifier {
  private readonly config: ClassifierConfig;
  private readonly cache: LRUCache<ClassificationResult>;
  private readonly logger: Logger;
  private readonly metrics: ClassifierMetrics;

  constructor(
    config: ClassifierConfig,
    cache: LRUCache<ClassificationResult>,
    metrics: ClassifierMetrics,
    logger: Logger,
  ) {
    this.config = config;
    this.cache = cache;
    this.metrics = metrics;
    this.logger = logger;
  }

  async classify(query: string): Promise<ClassificationResult> {
    if (!this.config.enabled) {
      return DEFAULT_RESULT;
    }

    // Normalize query for cache key
    const normalizedQuery = query.trim().toLowerCase().slice(0, 200);
    const cacheKey = LRUCache.buildCacheKey(normalizedQuery, "classifier");

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.metrics.classifierHits++;
      this.logger.info(`classifier: cache hit for query="${query.slice(0, 40)}..."`);
      return cached;
    }

    // Fast path for obvious patterns (no LLM call needed)
    const fastResult = this.fastClassify(query);
    if (fastResult) {
      this.cache.set(cacheKey, fastResult);
      this.logger.info(`classifier: fast path for query="${query.slice(0, 40)}..." → ${fastResult.queryType}`);
      return fastResult;
    }

    // LLM classification
    const apiKey = this.config.apiKey ?? process.env.MEM0_CLASSIFIER_API_KEY;
    if (!apiKey) {
      this.logger.info("classifier: skipped (no API key)");
      return DEFAULT_RESULT;
    }

    const { apiBase, model } = normalizeChatApiConfig({
      apiBase: this.config.apiBase,
      model: this.config.model,
    });

    this.metrics.classifierCalls++;
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const isKimi = isKimiCodingBaseUrl(apiBase);
      const resp = await fetch(
        isKimi ? buildKimiMessagesUrl(apiBase) : `${apiBase.replace(/\/+$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: isKimi
            ? {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "User-Agent": "claude-code/0.1.0",
              }
            : {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
          body: JSON.stringify(isKimi
            ? {
                model,
                system: SYSTEM_PROMPT,
                messages: [
                  { role: "user", content: buildUserPrompt(query) },
                ],
                max_tokens: 150,
                temperature: 0.1,
              }
            : {
                model,
                messages: [
                  { role: "system", content: SYSTEM_PROMPT },
                  { role: "user", content: buildUserPrompt(query) },
                ],
                max_tokens: 150,
                temperature: 0.1,
                response_format: { type: "json_object" },
              }),
          signal: controller.signal,
        }
      );

      clearTimeout(timer);

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => "");
        this.logger.warn(`classifier: HTTP ${resp.status} — ${errorText.slice(0, 200)}`);
        this.metrics.classifierErrors++;
        return DEFAULT_RESULT;
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

      const result = parseClassificationResponse(content);
      if (!result) {
        this.logger.warn(`classifier: failed to parse response: ${String(content).slice(0, 100)}`);
        this.metrics.classifierErrors++;
        return DEFAULT_RESULT;
      }

      this.cache.set(cacheKey, result);
      const elapsed = Date.now() - start;
      this.logger.info(`classifier: ${query.slice(0, 40)}... → tier=${result.tier} type=${result.queryType} (${elapsed}ms)`);

      return result;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        this.logger.warn("classifier: timeout");
      } else {
        this.logger.warn(`classifier: error — ${String(err)}`);
      }
      this.metrics.classifierErrors++;
      return DEFAULT_RESULT;
    }
  }

  /**
   * Fast regex-based classification for obvious patterns.
   * Returns null if LLM classification is needed.
   */
  private fastClassify(query: string): ClassificationResult | null {
    const trimmed = query.trim();
    const lower = trimmed.toLowerCase();

    // Greeting patterns
    if (/^(你好|hi|hello|hey|嗨|哈喽|早|晚安|早安|午安|在吗|在不在|嘿|yo)[\s!！。.？?~～]*$/i.test(trimmed)) {
      return {
        tier: "SIMPLE",
        queryType: "greeting",
        targetCategories: [],
        captureHint: "skip",
      };
    }

    // Pure acknowledgment
    if (/^(ok|okay|好的|嗯|行|收到|知道了|谢谢|thanks?)[\s.!。!]*$/i.test(trimmed)) {
      return {
        tier: "SIMPLE",
        queryType: "greeting",
        targetCategories: [],
        captureHint: "skip",
      };
    }

    // Code-related keywords
    if (/(?:检查|查看|读取|分析|review|check|read|look at|examine)\s*(?:代码|文件|index\.ts|\.js|\.ts|\.py|函数|逻辑)/i.test(lower) ||
        /^(?:看看|帮我看|帮我检查|分析一下)\s*.+\.(?:ts|js|py|go|rs|java)/i.test(lower)) {
      return {
        tier: "COMPLEX",
        queryType: "code",
        targetCategories: ["technical"],
        captureHint: "skip",
      };
    }

    // Debug-related keywords
    if (/(?:报错|error|bug|fail|失败|崩溃|crash|为什么.*?不|怎么.*?修|how to fix)/i.test(lower)) {
      return {
        tier: "COMPLEX",
        queryType: "debug",
        targetCategories: ["technical"],
        captureHint: "skip",
      };
    }

    // Identity queries
    if (/(?:我(?:的|叫)?(?:名字|姓名)|我是谁|我叫什么|what(?:'s| is) my name)/i.test(lower)) {
      return {
        tier: "SIMPLE",
        queryType: "factual",
        targetCategories: ["identity", "profile"],
        captureHint: "full",
      };
    }

    // Timezone queries
    if (/(?:我的?时区|timezone|utc|时差)/i.test(lower)) {
      return {
        tier: "SIMPLE",
        queryType: "factual",
        targetCategories: ["identity", "profile"],
        captureHint: "full",
      };
    }

    // Preference queries
    if (/(?:我(?:喜欢|偏好|爱|习惯)|prefer|favorite|喜好)/i.test(lower)) {
      return {
        tier: "MEDIUM",
        queryType: "preference",
        targetCategories: ["preferences", "preference"],
        captureHint: "full",
      };
    }

    return null;
  }
}

export { DEFAULT_RESULT as DEFAULT_CLASSIFICATION };
