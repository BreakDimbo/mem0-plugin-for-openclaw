import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFreeTextMetadata, genericConceptBoost, rerankMemoryResults, tokenizeSemanticQuery } from "./metadata.js";
import type { MemuMemoryRecord, MemoryScope } from "./types.js";

const TOP_LEVEL_FILES = ["USER.md", "MEMORY.md", "IDENTITY.md", "TOOLS.md", "HEARTBEAT.md", "AGENTS.md"];
const NESTED_DIRS = ["memory", "notes", ".learnings"];
const MAX_SNIPPET_CHARS = 220;

function normalizeSemanticText(text: string): string {
  return text
    .toLowerCase()
    .replace(/^(请只用一句中文回答[:：]?|请用一句中文回答[:：]?|请用三行中文回答，不要解释[:：]?|请回答[:：]?)/, "")
    .replace(/\s+/g, "")
    .replace(/[，。、“”"'`·:：；;（）()【】\[\]\-?!？]/g, "");
}

function isQueryMirrorSnippet(query: string, snippet: string): boolean {
  const q = normalizeSemanticText(query);
  const s = normalizeSemanticText(snippet);
  if (!q || !s) return false;
  if (q === s) return true;
  if (s.includes(q)) return true;
  return false;
}

function scoreSnippet(query: string, text: string): number {
  const normalized = text.toLowerCase();
  const tokens = tokenizeSemanticQuery(query);
  const conceptBonus = genericConceptBoost(query, text);
  if (tokens.length === 0) return conceptBonus;
  let hits = 0;
  for (const token of tokens) {
    if (normalized.includes(token)) hits++;
  }
  return hits / tokens.length + conceptBonus;
}

function isCandidateLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.length < 6 || trimmed.length > MAX_SNIPPET_CHARS) return false;
  if (/^```/.test(trimmed)) return false;
  if (/^\|[-\s|:]+\|?$/.test(trimmed)) return false;
  if (/^#+\s*$/.test(trimmed)) return false;
  if (/^[a-f0-9]{16,}$/i.test(trimmed)) return false;
  if (/^(om|ou|on|oc|chat|msg|thread)_[a-z0-9]{8,}$/i.test(trimmed)) return false;
  if (/^(message_id|sender_id|timestamp|sender|label|id)\s*:/i.test(trimmed)) return false;
  return /[\u4e00-\u9fffA-Za-z]/.test(trimmed);
}

function normalizeLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/\s+/g, " ");
}

function extractSnippets(content: string): string[] {
  const snippets: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = normalizeLine(rawLine);
    if (!isCandidateLine(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    snippets.push(line);
  }

  return snippets;
}

async function listMarkdownFiles(workspaceDir: string, maxNestedFiles: number): Promise<string[]> {
  const files = TOP_LEVEL_FILES.map((name) => path.join(workspaceDir, name));

  for (const dirName of NESTED_DIRS) {
    const dirPath = path.join(workspaceDir, dirName);
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const markdownEntries = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        .map(async (entry) => {
          const fullPath = path.join(dirPath, entry.name);
          const stat = await fs.stat(fullPath);
          return { fullPath, mtimeMs: stat.mtimeMs };
        }));
      markdownEntries
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, maxNestedFiles)
        .forEach((entry) => files.push(entry.fullPath));
    } catch {
      // Optional workspace folders are best-effort only.
    }
  }

  return files;
}

export async function searchWorkspaceFacts(
  query: string,
  scope: MemoryScope,
  workspaceDir: string,
  opts?: { maxItems?: number; maxFiles?: number },
): Promise<MemuMemoryRecord[]> {
  const maxItems = Math.max(1, opts?.maxItems ?? 2);
  const maxFiles = Math.max(1, opts?.maxFiles ?? 6);
  const files = await listMarkdownFiles(workspaceDir, maxFiles);

  const candidates: MemuMemoryRecord[] = [];
  const seen = new Set<string>();

  for (const filePath of files) {
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    for (const snippet of extractSnippets(content)) {
      if (seen.has(snippet)) continue;
      if (isQueryMirrorSnippet(query, snippet)) continue;
      const score = scoreSnippet(query, snippet);
      if (score <= 0) continue;
      seen.add(snippet);
      candidates.push({
        id: `${path.basename(filePath)}:${candidates.length + 1}`,
        text: snippet,
        category: "workspace_fact",
        score,
        source: "memu_item",
        scope,
        metadata: {
          ...buildFreeTextMetadata(snippet, scope, {
            captureKind: "explicit",
            extra: {
              source: "workspace-facts",
              workspace_file: path.relative(workspaceDir, filePath),
            },
          }),
        },
      });
    }
  }

  return rerankMemoryResults(query, candidates, { preferDurable: true }).slice(0, maxItems);
}

export function resolveWorkspaceDir(agentId: string, explicitWorkspaceDir?: string): string {
  if (explicitWorkspaceDir?.trim()) return explicitWorkspaceDir.trim();
  const baseDir = path.join(os.homedir(), ".openclaw");
  return agentId === "main" ? path.join(baseDir, "workspace") : path.join(baseDir, `workspace-${agentId}`);
}
