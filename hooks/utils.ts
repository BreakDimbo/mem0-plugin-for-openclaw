// ============================================================================
// Shared hook utilities
// ============================================================================

/**
 * Extract text from message content (handles string, structured content array, or unknown)
 */
export function extractTextBlocks(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } =>
      !!b && typeof b === "object" && b.type === "text" && typeof b.text === "string"
    )
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Extract senderId from prompt string (supports JSON and legacy formats)
 */
export function extractSenderId(raw: string): string | undefined {
  const jsonPatterns = [
    /"sender_id"\s*:\s*"([^"]{3,200})"/i,
    /\\"sender_id\\"\s*:\s*\\"([^"\\]{3,200})\\"/i,
    /"from"\s*:\s*"([^"]{3,200})"/i,
  ];
  for (const p of jsonPatterns) {
    const m = raw.match(p);
    if (m?.[1]) return m[1].trim();
  }
  const match = raw.match(/\[user:([^\]]+)\]/) || raw.match(/From:\s*(\S+)/);
  return match?.[1] ?? undefined;
}

/**
 * Strip injected memory blocks from text
 */
export function stripInjectedBlocks(raw: string): string {
  return raw
    .replace(/<core-memory>[\s\S]*?<\/core-memory>/gi, " ")
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/gi, " ")
    .replace(/\[truncated by injection budget\]/gi, " ")
    .trim();
}
