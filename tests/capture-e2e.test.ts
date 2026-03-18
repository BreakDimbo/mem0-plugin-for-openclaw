// ============================================================================
// E2E Test: capture hook with injected memory filtering
// Simulates the capture hook behavior with mock data
// ============================================================================

import { createCaptureHook } from "../hooks/capture.js";
import type { MemuPluginConfig, MemuMemoryRecord, ClassificationResult, ConversationMessage } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";
import { Metrics } from "../metrics.js";

// Mock implementations
class MockOutbox {
  queue: Array<{ text: string; scope: any }> = [];

  enqueue(text: string, scope: any, _meta?: any) {
    this.queue.push({ text, scope });
  }
}

class MockCoreRepo {
  async upsert() { return true; }
}

class MockProposalQueue {
  enqueue() {}
}

class MockCache {
  get() { return undefined; }
}

class MockLogger {
  logs: string[] = [];
  info(msg: string) { this.logs.push(`INFO: ${msg}`); }
  warn(msg: string) { this.logs.push(`WARN: ${msg}`); }
}

class MockSync {
  registerAgent() {}
  scheduleSync() {}
}

class MockCandidateQueue {
  queue: Array<{ messages: ConversationMessage[]; scope: any }> = [];

  enqueue(messages: ConversationMessage[], scope: any, _meta?: any) {
    this.queue.push({ messages, scope });
  }

  async start() {}

  // Helper to get text from last user message
  getText(index: number): string {
    const item = this.queue[index];
    if (!item) return "";
    const lastUser = [...item.messages].reverse().find(m => m.role === "user");
    return lastUser?.content ?? "";
  }

  getMessages(index: number): ConversationMessage[] {
    return this.queue[index]?.messages ?? [];
  }
}

class MockInboundCache {
  data: Map<string, { content: string; classification?: ClassificationResult }> = new Map();

  private makeSenderKey(channelId: string, senderId: string): string {
    return `${channelId}::${senderId}`;
  }

  private normalizeSenderVariants(senderId: string): string[] {
    const raw = senderId.trim();
    if (!raw) return [];
    const variants = new Set<string>([raw]);
    const idx = raw.indexOf(":");
    if (idx > 0 && idx < raw.length - 1) {
      variants.add(raw.slice(idx + 1));
    } else {
      variants.add(`feishu:${raw}`);
    }
    return Array.from(variants);
  }

  async set(channelId: string, senderId: string, content: string) {
    for (const sid of this.normalizeSenderVariants(senderId)) {
      this.data.set(this.makeSenderKey(channelId, sid), { content });
    }
  }

  async getBySender(channelId: string, senderId: string) {
    for (const sid of this.normalizeSenderVariants(senderId)) {
      const entry = this.data.get(this.makeSenderKey(channelId, sid));
      if (entry?.content) return entry.content;
    }
    return undefined;
  }

  async getClassification(channelId: string, senderId: string) {
    for (const sid of this.normalizeSenderVariants(senderId)) {
      const entry = this.data.get(this.makeSenderKey(channelId, sid));
      if (entry?.classification) return entry.classification;
    }
    return undefined;
  }

  async setClassification(channelId: string, senderId: string, classification: ClassificationResult) {
    for (const sid of this.normalizeSenderVariants(senderId)) {
      const key = this.makeSenderKey(channelId, sid);
      const entry = this.data.get(key);
      if (entry) {
        entry.classification = classification;
      }
    }
  }
}

// Create test config
function createTestConfig(): MemuPluginConfig {
  return {
    ...DEFAULT_CONFIG,
    capture: {
      ...DEFAULT_CONFIG.capture,
      enabled: true,
      candidateQueue: {
        enabled: true,
        intervalMs: 10000,
        maxBatchSize: 50,
      },
    },
  };
}

// Test runner
async function runTests() {
  console.log("=== E2E Capture Hook Tests ===\n");
  let passed = 0;
  let failed = 0;

  // Test 1: Normal user message should be captured
  {
    const name = "Normal user message captured via candidateQueue";
    const outbox = new MockOutbox();
    const candidateQueue = new MockCandidateQueue();
    const logger = new MockLogger();
    const metrics = new Metrics();
    const inbound = new MockInboundCache();

    const config = createTestConfig();
    const hook = createCaptureHook(
      outbox as any,
      new MockCoreRepo() as any,
      new MockProposalQueue() as any,
      new MockCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      candidateQueue as any,
      inbound as any,
    );

    // Use a longer message that exceeds minChars=20
    const longMessage = "我的名字是张三，我在北京一家科技公司工作，负责后端开发";
    await inbound.set("channel1", "user123", longMessage);

    await hook(
      {
        messages: [
          { role: "user", content: longMessage, sender_id: "user123" },
        ],
      },
      { channelId: "channel1" },
    );

    if (candidateQueue.queue.length === 1 && candidateQueue.getText(0).includes("张三")) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  Queue length: ${candidateQueue.queue.length}`);
      console.log(`  Queue content: ${JSON.stringify(candidateQueue.queue)}`);
      console.log(`  Metrics: total=${metrics.captureTotal}, captured=${metrics.captureCaptured}, filtered=${metrics.captureFiltered}`);
      failed++;
    }
  }

  // Test 2: Message with injected core-memory should NOT be captured from event.messages
  {
    const name = "Message with <core-memory> block filtered (event.messages fallback)";
    const outbox = new MockOutbox();
    const candidateQueue = new MockCandidateQueue();
    const logger = new MockLogger();
    const metrics = new Metrics();
    const inbound = new MockInboundCache();

    const config = createTestConfig();
    const hook = createCaptureHook(
      outbox as any,
      new MockCoreRepo() as any,
      new MockProposalQueue() as any,
      new MockCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      candidateQueue as any,
      inbound as any,
    );

    // No inbound cache, force fallback to event.messages
    await hook(
      {
        messages: [
          {
            role: "user",
            content: "<core-memory>\n- name: 张三\n</core-memory>\n\n帮我写代码",
          },
        ],
      },
      { channelId: "channel2" },
    );

    if (candidateQueue.queue.length === 0) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  Queue length: ${candidateQueue.queue.length}, expected 0`);
      console.log(`  Queue content: ${JSON.stringify(candidateQueue.queue)}`);
      failed++;
    }
  }

  // Test 3: Message with injected relevant-memories should NOT be captured
  {
    const name = "Message with <relevant-memories> block filtered";
    const outbox = new MockOutbox();
    const candidateQueue = new MockCandidateQueue();
    const logger = new MockLogger();
    const metrics = new Metrics();
    const inbound = new MockInboundCache();

    const config = createTestConfig();
    const hook = createCaptureHook(
      outbox as any,
      new MockCoreRepo() as any,
      new MockProposalQueue() as any,
      new MockCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      candidateQueue as any,
      inbound as any,
    );

    await hook(
      {
        messages: [
          {
            role: "user",
            content: "<relevant-memories>\n- User likes Python\n</relevant-memories>\n\n用什么语言？",
          },
        ],
      },
      { channelId: "channel3" },
    );

    if (candidateQueue.queue.length === 0) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  Queue length: ${candidateQueue.queue.length}, expected 0`);
      failed++;
    }
  }

  // Test 4: Inbound cache takes priority over injected event.messages
  {
    const name = "Inbound cache (raw message) takes priority over injected event.messages";
    const outbox = new MockOutbox();
    const candidateQueue = new MockCandidateQueue();
    const logger = new MockLogger();
    const metrics = new Metrics();
    const inbound = new MockInboundCache();

    const config = createTestConfig();
    const hook = createCaptureHook(
      outbox as any,
      new MockCoreRepo() as any,
      new MockProposalQueue() as any,
      new MockCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      candidateQueue as any,
      inbound as any,
    );

    // Inbound cache has raw message (long enough to pass minChars)
    const rawMessage = "我非常喜欢用Python编程，特别是数据分析方面的工作";
    await inbound.set("channel4", "user456", rawMessage);

    // event.messages has injected content
    await hook(
      {
        messages: [
          {
            role: "user",
            content: "<core-memory>\n- language: Python\n</core-memory>\n\n" + rawMessage,
            sender_id: "user456",
          },
        ],
      },
      { channelId: "channel4" },
    );

    if (candidateQueue.queue.length === 1 && candidateQueue.getText(0).includes("Python")) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  Queue length: ${candidateQueue.queue.length}`);
      console.log(`  Queue content: ${JSON.stringify(candidateQueue.queue)}`);
      console.log(`  Metrics: total=${metrics.captureTotal}, captured=${metrics.captureCaptured}, filtered=${metrics.captureFiltered}`);
      failed++;
    }
  }

  // Test 5: Assistant messages should NOT be captured (role check)
  {
    const name = "Assistant messages filtered by role check";
    const outbox = new MockOutbox();
    const candidateQueue = new MockCandidateQueue();
    const logger = new MockLogger();
    const metrics = new Metrics();
    const inbound = new MockInboundCache();

    const config = createTestConfig();
    const hook = createCaptureHook(
      outbox as any,
      new MockCoreRepo() as any,
      new MockProposalQueue() as any,
      new MockCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      candidateQueue as any,
      inbound as any,
    );

    await hook(
      {
        messages: [
          { role: "assistant", content: "这是助手的回复" },
          { role: "toolResult", content: "工具执行结果" },
        ],
      },
      { channelId: "channel5" },
    );

    if (candidateQueue.queue.length === 0) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  Queue length: ${candidateQueue.queue.length}, expected 0`);
      failed++;
    }
  }

  // Test 6: Low signal messages filtered
  {
    const name = "Low signal messages filtered";
    const outbox = new MockOutbox();
    const candidateQueue = new MockCandidateQueue();
    const logger = new MockLogger();
    const metrics = new Metrics();
    const inbound = new MockInboundCache();

    const config = createTestConfig();
    const hook = createCaptureHook(
      outbox as any,
      new MockCoreRepo() as any,
      new MockProposalQueue() as any,
      new MockCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      candidateQueue as any,
      inbound as any,
    );

    await inbound.set("channel6", "user789", "好的");

    await hook(
      {
        messages: [
          { role: "user", content: "好的", sender_id: "user789" },
        ],
      },
      { channelId: "channel6" },
    );

    if (candidateQueue.queue.length === 0 && metrics.captureFiltered === 1) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  Queue length: ${candidateQueue.queue.length}, filtered: ${metrics.captureFiltered}`);
      failed++;
    }
  }

  // Test 7: Failed agent_end should not be captured
  {
    const name = "Failed agent_end is skipped";
    const outbox = new MockOutbox();
    const candidateQueue = new MockCandidateQueue();
    const logger = new MockLogger();
    const metrics = new Metrics();
    const inbound = new MockInboundCache();

    const config = createTestConfig();
    const hook = createCaptureHook(
      outbox as any,
      new MockCoreRepo() as any,
      new MockProposalQueue() as any,
      new MockCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      candidateQueue as any,
      inbound as any,
    );

    await hook(
      {
        success: false,
        messages: [
          { role: "user", content: "我非常喜欢用Python编程，特别是数据分析方面的工作", sender_id: "user999" },
        ],
      },
      { channelId: "channel7" },
    );

    if (candidateQueue.queue.length === 0 && metrics.captureCaptured === 0) {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  Queue length: ${candidateQueue.queue.length}, captured: ${metrics.captureCaptured}`);
      failed++;
    }
  }

  // Test 8: Capture preserves multi-line assistant content instead of query-sanitizing it
  {
    const name = "Assistant content is preserved in conversation capture";
    const outbox = new MockOutbox();
    const candidateQueue = new MockCandidateQueue();
    const logger = new MockLogger();
    const metrics = new Metrics();
    const inbound = new MockInboundCache();

    const config = createTestConfig();
    const hook = createCaptureHook(
      outbox as any,
      new MockCoreRepo() as any,
      new MockProposalQueue() as any,
      new MockCache() as any,
      config,
      logger,
      metrics,
      new MockSync() as any,
      candidateQueue as any,
      inbound as any,
    );

    await hook(
      {
        messages: [
          { role: "user", content: "我现在在维护一个 memory plugin，最近在修 capture 流程" },
          { role: "assistant", content: "第一行是总结\n第二行是细节\n第三行是结论" },
          { role: "user", content: "请继续展开说明这个 capture 流程的边界条件和回归点" },
        ],
      },
      { channelId: "channel8" },
    );

    const assistantMessage = candidateQueue.getMessages(0).find((message) => message.role === "assistant")?.content;
    if (assistantMessage === "第一行是总结\n第二行是细节\n第三行是结论") {
      console.log(`✓ ${name}`);
      passed++;
    } else {
      console.log(`✗ ${name}`);
      console.log(`  Assistant message: ${JSON.stringify(assistantMessage)}`);
      failed++;
    }
  }

  console.log(`\n=== Results: ${passed}/${passed + failed} passed ===`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
