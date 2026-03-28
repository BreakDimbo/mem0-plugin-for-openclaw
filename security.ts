// ============================================================================
// Security: escape, filtering, injection detection, audit logging
// Phase 2/3: enhanced injection context, audit for forget
// ============================================================================

import type { CoreMemoryRecord, MemuMemoryRecord } from "./types.js";

const XML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeForInjection(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => XML_ESCAPE_MAP[ch] ?? ch);
}

export function formatMemoriesContext(memories: MemuMemoryRecord[]): string {
  if (memories.length === 0) return "";

  const lines = memories.map((m) => {
    const categoryTag = m.category ? `[${escapeForInjection(m.category)}] ` : "";
    return `${categoryTag}${escapeForInjection(m.text)}`;
  });

  return [
    "<relevant-memories>",
    "补充历史事实。仅当 core-memory 没覆盖答案时再参考，不要把区块名当作答案内容。",
    "",
    ...lines,
    "</relevant-memories>",
  ].join("\n");
}

export function isValidCoreKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9_.-]{1,79}$/.test(key);
}

function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

export function sanitizeCoreValue(text: string, maxChars: number): string {
  const stripped = stripControlChars(text).replace(/\s+/g, " ");
  return stripped.length > maxChars ? stripped.slice(0, maxChars) : stripped;
}

/**
 * Detect knowledge dumps: domain content, regulation text, multi-clause lists.
 * Core Memory is for personal facts only. This blocks study notes, law articles,
 * and multi-point reference content.
 *
 * Patterns:
 *   - Circled numbers ①②③ — used as enumeration markers in study notes
 *   - Chinese official document citation markers: （来源：, （出处：
 *   - Chinese official document numbers: 〔YYYY〕N号
 *   - Law/regulation article references: 第N条 (any form)
 *   - ≥2 long semicolon-separated clauses (≥8 chars each) — regulation paraphrase format
 */
const KNOWLEDGE_DUMP_PATTERNS: RegExp[] = [
  /[①②③④⑤⑥⑦⑧⑨⑩]/,                     // Circled number enumeration markers
  /（来源：|（出处：/,                         // Citation markers common in study notes
  /〔\d{4}〕\d+号/,                           // Chinese official document numbers
  /第\s*[一二三四五六七八九十百\d]+\s*条/,    // Law article references (any form)
  /(?:[；;][^；;\n]{8,}){3,}/,               // ≥3 semicolon-separated clauses of ≥8 chars each
  /(?:\d+[)）][^)）\n]{2,}){4,}/,           // ≥4 consecutive numbered items (study note lists)
  // System / operational noise — no durable user facts
  /HEARTBEAT/i,                              // Heartbeat check messages (any variant)
  /心跳检查|无紧急事项/,                      // Chinese heartbeat / status-ok phrases
  /\bThe current time is (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i, // Timestamp-only messages
  /\bThe user requested the system to read\b/i, // Agent self-narration with no user content
];

export function isKnowledgeDump(value: string): boolean {
  return KNOWLEDGE_DUMP_PATTERNS.some((p) => p.test(value));
}

export function shouldStoreCoreMemory(key: string, value: string, maxChars: number): boolean {
  if (!isValidCoreKey(key)) return false;
  const normalized = sanitizeCoreValue(value, maxChars);
  if (normalized.length < 3) return false;
  if (isSensitiveContent(normalized)) return false;
  if (isKnowledgeDump(normalized)) return false;
  return true;
}

/**
 * Simplify key path display:
 * - identity/identity.name → identity/name
 * - preferences/preferences.editor → preferences/editor
 */
function simplifyKey(category: string | undefined, key: string): string {
  if (!category) return key;
  // If key starts with "category.", strip that prefix
  if (key.startsWith(`${category}.`)) {
    return `${category}/${key.slice(category.length + 1)}`;
  }
  return `${category}/${key}`;
}

export function formatCoreMemoriesContext(memories: CoreMemoryRecord[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => {
    const tag = simplifyKey(m.category, m.key);
    return `[${escapeForInjection(tag)}] ${escapeForInjection(m.value)}`;
  });
  return [
    "<core-memory>",
    "稳定事实，优先级高于 relevant-memories。若这里已覆盖答案，直接据此作答，不要说缺少数据，也不要把区块名当作答案内容。",
    "",
    ...lines,
    "</core-memory>",
  ].join("\n");
}

export function applyInjectionBudget(sections: string[], budgetChars: number): string {
  const budget = Math.max(100, budgetChars);
  const chunks = sections.map((s) => s.trim()).filter(Boolean);
  if (chunks.length === 0) return "";

  let used = 0;
  const out: string[] = [];
  for (const chunk of chunks) {
    const separator = out.length > 0 ? 2 : 0;
    const room = budget - used - separator;
    if (room <= 0) break;
    if (chunk.length <= room) {
      out.push(chunk);
      used += separator + chunk.length;
      continue;
    }
    const TRUNCATION_MARKER = "\n[truncated by injection budget]";
    const truncated = chunk.slice(0, Math.max(0, room - TRUNCATION_MARKER.length)).trimEnd();
    if (!truncated) break;
    out.push(`${truncated}${TRUNCATION_MARKER}`);
    break;
  }
  return out.join("\n\n");
}

// Sensitive data patterns
const SENSITIVE_PATTERNS = [
  /\b1[3-9]\d{9}\b/,                    // Chinese phone numbers
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,      // US phone numbers
  /\b[\w.-]+@[\w.-]+\.\w{2,}\b/,        // Email addresses
  /\b\d{6}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/, // Chinese ID numbers
  /\b\d{3}-\d{2}-\d{4}\b/,              // SSN
  /\b(?:sk-|pk-|rk-)[a-zA-Z0-9]{20,}\b/, // API keys
];

export function isSensitiveContent(text: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(text));
}

export function shouldCapture(text: string, minChars: number, maxChars: number): { allowed: boolean; reason?: string } {
  const len = text.trim().length;
  if (len < minChars) return { allowed: false, reason: `too_short (len=${len} < min=${minChars})` };
  if (len > maxChars) return { allowed: false, reason: `too_long (len=${len} > max=${maxChars})` };
  if (isSensitiveContent(text)) return { allowed: false, reason: "sensitive_content_detected" };
  return { allowed: true };
}

// -- Audit Logging --

export type AuditEntry = {
  timestamp: string;
  action: "forget" | "store" | "recall";
  userId: string;
  agentId: string;
  details: string;
};

const auditLog: AuditEntry[] = [];
const MAX_AUDIT_LOG = 500;

export function audit(action: AuditEntry["action"], userId: string, agentId: string, details: string): void {
  auditLog.push({
    timestamp: new Date().toISOString(),
    action,
    userId,
    agentId,
    details,
  });

  if (auditLog.length > MAX_AUDIT_LOG) {
    auditLog.splice(0, auditLog.length - MAX_AUDIT_LOG);
  }
}

export function getAuditLog(limit = 50): AuditEntry[] {
  return auditLog.slice(-limit);
}
