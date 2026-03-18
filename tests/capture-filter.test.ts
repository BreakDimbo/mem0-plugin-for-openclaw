// ============================================================================
// Test: capture hook filtering logic
// Verifies that injected memory content is correctly filtered out
// ============================================================================

import { sanitizePromptQuery } from "../hooks/recall.js";

// Re-implement the filtering logic from capture.ts for testing
const SKIP_PREFIXES = ["[system]", "[tool_result]", "<system", "```tool", "<relevant-memories>"];

function isSystemFragment(text: string): boolean {
  const lower = text.trimStart().toLowerCase();
  return SKIP_PREFIXES.some((p) => lower.startsWith(p));
}

function isInjectedMemory(text: string): boolean {
  return text.includes("<relevant-memories>") || text.includes("</relevant-memories>") ||
         text.includes("<core-memory>") || text.includes("</core-memory>");
}

function isLowSignalUserText(text: string): boolean {
  const LOW_SIGNAL_PATTERNS = [
    /^\s*(ok|okay|好的|嗯|行|收到|知道了|谢谢|thanks?)\s*[.!。!]*\s*$/i,
    /\b(today|tomorrow|tonight|this morning|this afternoon|this evening)\b/i,
    /\b明天\b|\b今天\b|\b今晚\b/,
    /\btest(ing)?\b|\bdebug\b|\boutbox\b|\bmemu\b/i,
    /测试|调试|联调|修复/,
  ];
  const trimmed = text.trim();
  if (!trimmed) return true;
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function shouldCaptureText(text: string): boolean {
  // Check raw text first for injected content (before sanitization)
  if (isInjectedMemory(text)) return false;
  if (isSystemFragment(text)) return false;

  const sanitized = sanitizePromptQuery(text);
  if (!sanitized) return false;
  if (isLowSignalUserText(sanitized)) return false;
  return true;
}

// Test cases
const testCases: Array<{ input: string; expected: boolean; description: string }> = [
  // Should capture: normal user messages
  {
    input: "我的名字叫张三",
    expected: true,
    description: "Normal user message (Chinese name)",
  },
  {
    input: "What is the capital of France?",
    expected: true,
    description: "Normal user message (English question)",
  },
  {
    input: "帮我实现一个排序算法",
    expected: true,
    description: "Normal coding request",
  },

  // Should NOT capture: injected memory content
  {
    input: "<core-memory>\n- name: 张三\n- timezone: UTC+8\n</core-memory>\n\n帮我修改代码",
    expected: false,
    description: "Message with injected core-memory block",
  },
  {
    input: "<relevant-memories>\n- User prefers Python\n</relevant-memories>\n\n用什么语言写？",
    expected: false,
    description: "Message with injected relevant-memories block",
  },
  {
    input: "User query\n\n<core-memory>data</core-memory>",
    expected: false,
    description: "Message with trailing core-memory block",
  },

  // Should NOT capture: system fragments
  {
    input: "[system] This is a system message",
    expected: false,
    description: "System message prefix",
  },
  {
    input: "[tool_result] Tool execution result",
    expected: false,
    description: "Tool result prefix",
  },
  {
    input: "<system-reminder>Remember to...</system-reminder>",
    expected: false,
    description: "System reminder tag",
  },

  // Should NOT capture: low signal
  {
    input: "好的",
    expected: false,
    description: "Low signal: acknowledgment",
  },
  {
    input: "thanks",
    expected: false,
    description: "Low signal: thanks",
  },
  {
    input: "测试一下",
    expected: false,
    description: "Low signal: testing",
  },

  // Edge cases
  {
    input: "请问core-memory是什么功能？",
    expected: true,
    description: "Question about core-memory (not injected block)",
  },
  {
    input: "如何使用relevant-memories？",
    expected: true,
    description: "Question about relevant-memories (not injected block)",
  },
];

// Run tests
console.log("=== Capture Filter Tests ===\n");
let passed = 0;
let failed = 0;

for (const tc of testCases) {
  const actual = shouldCaptureText(tc.input);
  const status = actual === tc.expected ? "✓" : "✗";

  if (actual === tc.expected) {
    passed++;
    console.log(`${status} ${tc.description}`);
  } else {
    failed++;
    console.log(`${status} ${tc.description}`);
    console.log(`   Input: "${tc.input.slice(0, 60)}${tc.input.length > 60 ? "..." : ""}"`);
    console.log(`   Expected: ${tc.expected}, Got: ${actual}`);
  }
}

console.log(`\n=== Results: ${passed}/${testCases.length} passed ===`);

if (failed > 0) {
  process.exit(1);
}
