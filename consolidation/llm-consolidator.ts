// ============================================================================
// LLMConsolidator — asks any OpenAI-compatible LLM for verdicts on
// boundary-zone memory records where the score alone is inconclusive.
//
// Supports: local Ollama (Qwen/Llama/etc), Kimi Coding, OpenAI, LiteLLM, OpenRouter.
// Used by ConsolidationRunner when config.core.consolidation.llm.enabled=true.
// ============================================================================

import type { CoreMemoryRecord, ConsolidationLLMConfig } from "../types.js";
import type { LLMVerdict, MemoryVerdict, ScoredMemory } from "./types.js";

type Logger = { info(msg: string): void; warn(msg: string): void };

// ── Prompt building ──────────────────────────────────────────────────────────

function buildPrompt(records: ScoredMemory<CoreMemoryRecord>[]): string {
  const items = records.map((s, i) =>
    `${i + 1}. [id:${s.record.id}] [${s.record.category ?? "general"}/${s.record.key}] ` +
    `score=${s.score.toFixed(3)} — "${s.record.value.slice(0, 120)}"`,
  );

  return `You are a memory importance judge for an AI assistant.
Review each memory entry and decide what to do with it.

Verdicts:
- "keep"      — still useful, should be retained
- "downgrade" — borderline, lower priority but keep
- "archive"   — rarely useful, should not be injected but preserve
- "delete"    — stale, redundant, or low-value; safe to remove

For "merge" entries, also provide a mergedValue (combined concise text).

Return ONLY a JSON array (no markdown), one object per entry:
[{"id":"<id>","verdict":"<verdict>","reason":"<one sentence>"}]

Memory entries to evaluate:
${items.join("\n")}`;
}

// ── Response parsing ─────────────────────────────────────────────────────────

function parseVerdicts(raw: string, expectedIds: string[]): LLMVerdict[] {
  // Strip markdown code fences if present
  let text = raw;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) text = fenced[1];

  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (!arrMatch) return [];

  try {
    const parsed = JSON.parse(arrMatch[0]) as Array<Record<string, unknown>>;
    const results: LLMVerdict[] = [];

    const validVerdicts: MemoryVerdict[] = ["keep", "downgrade", "merge", "archive", "delete"];

    for (const item of parsed) {
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const verdict = (item.verdict as string)?.toLowerCase().trim() as MemoryVerdict;
      const reason = typeof item.reason === "string" ? item.reason.slice(0, 200) : "LLM verdict";

      if (!id || !validVerdicts.includes(verdict)) continue;
      if (!expectedIds.includes(id)) continue;

      results.push({
        id,
        verdict,
        reason,
        mergedValue: typeof item.mergedValue === "string" ? item.mergedValue : undefined,
      });
    }

    return results;
  } catch {
    return [];
  }
}

// ── Main consolidator ────────────────────────────────────────────────────────

export class LLMConsolidator {
  private readonly config: ConsolidationLLMConfig;
  private readonly logger: Logger;

  constructor(config: ConsolidationLLMConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Ask the LLM to judge a batch of boundary-zone records.
   * Returns partial results (only IDs the LLM returned verdicts for).
   */
  async judgeRecords(
    records: ScoredMemory<CoreMemoryRecord>[],
  ): Promise<LLMVerdict[]> {
    if (!this.config.enabled || records.length === 0) return [];

    const batch = records.slice(0, this.config.maxBatchSize);
    const expectedIds = batch.map((s) => s.record.id);
    const prompt = buildPrompt(batch);

    const apiBase = this.config.apiBase.replace(/\/+$/, "");
    const url = `${apiBase}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;

    this.logger.info(`llm-consolidator: sending ${batch.length} records to ${this.config.model}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1000,
          temperature: 0.1,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        this.logger.warn(`llm-consolidator: HTTP ${resp.status} — ${errText.slice(0, 200)}`);
        return [];
      }

      const json = (await resp.json()) as Record<string, unknown>;
      const content = (json.choices as Array<{ message?: { content?: string } }> | undefined)
        ?.[0]?.message?.content ?? "";

      const verdicts = parseVerdicts(content, expectedIds);
      this.logger.info(`llm-consolidator: received ${verdicts.length}/${batch.length} verdicts`);
      return verdicts;
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        this.logger.warn("llm-consolidator: timeout");
      } else {
        this.logger.warn(`llm-consolidator: error — ${String(err)}`);
      }
      return [];
    }
  }
}
