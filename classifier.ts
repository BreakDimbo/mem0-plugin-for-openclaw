// ============================================================================
// UnifiedIntentClassifier: Single LLM call to classify query intent
// Used for: recall filtering, capture skip logic, injection optimization
// ============================================================================

import { LRUCache } from "./cache.js";
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

const SYSTEM_PROMPT = `你是意图分类器。分析用户消息，返回单个 JSON 对象。

分类维度：
1. tier: 任务复杂度
   - SIMPLE: 简单问答（你好/谢谢/时间/天气）
   - MEDIUM: 单步查询（我的名字/时区/偏好）
   - COMPLEX: 多步推理（对比/分析/规划）
   - REASONING: 需要深度思考（设计/架构/复杂调试）

2. queryType: 查询类型
   - greeting: 问候/闲聊（你好/早/嗨）
   - code: 代码相关（检查代码/看逻辑/读文件）
   - debug: 调试相关（报错/为什么失败/怎么修）
   - factual: 事实查询（我的名字/时区/在哪）
   - preference: 偏好查询（喜欢什么/习惯）
   - planning: 规划任务（帮我设计/制定计划）
   - open: 开放式/其他

3. targetCategories: 匹配的记忆类别（可多选）
   - identity: 身份信息（名字/时区/位置）
   - work: 工作相关
   - preferences: 偏好习惯
   - goals: 目标计划
   - constraints: 约束规则
   - relationships: 人际关系
   - technical: 技术配置
   - general: 通用

4. captureHint: 是否值得记忆
   - skip: 不需要记忆（问候/纯指令/闲聊）
   - light: 轻量处理（仅存 free_text）
   - full: 完整处理（可能有 core memory 价值）

只返回 JSON，不要其他文字：
{"tier":"MEDIUM","queryType":"factual","targetCategories":["identity"],"captureHint":"full"}`;

function buildUserPrompt(query: string): string {
  return `用户消息: ${query.slice(0, 500)}`;
}

function parseClassificationResponse(raw: unknown): ClassificationResult | null {
  let text = typeof raw === "string" ? raw : "";
  if (!text) return null;

  // Extract JSON from markdown code blocks if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) text = fenced[1];

  // Find JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

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
  } catch {
    return null;
  }
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

    const apiBase = this.config.apiBase ?? "https://generativelanguage.googleapis.com/v1beta/openai";
    const model = this.config.model ?? "gemini-2.5-flash";

    this.metrics.classifierCalls++;
    const start = Date.now();

    try {
      const url = `${apiBase.replace(/\/+$/, "")}/chat/completions`;
      const body = {
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(query) },
        ],
        max_tokens: 200,
        temperature: 0.1,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => "");
        this.logger.warn(`classifier: HTTP ${resp.status} — ${errorText.slice(0, 200)}`);
        this.metrics.classifierErrors++;
        return DEFAULT_RESULT;
      }

      const json = (await resp.json()) as Record<string, unknown>;
      const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
      const content = choices?.[0]?.message?.content;

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
