import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type E2ECase = {
  id: string;
  query: string;
  expected: string;
};

type E2EResult = {
  id: string;
  query: string;
  expected: string;
  answer: string;
  hit: boolean;
  durationMs: number;
};

const CASES: E2ECase[] = [
  { id: "e2e-01", query: "用户叫什么名字？", expected: "小明" },
  { id: "e2e-02", query: "用户的时区是什么？", expected: "UTC+8" },
  { id: "e2e-03", query: "用户现在的职业是什么？", expected: "某互联网公司高级后端工程师" },
  { id: "e2e-04", query: "用户主要深耕什么技术领域？", expected: "分布式系统与高并发" },
  { id: "e2e-05", query: "用户的人格倾向是什么？", expected: "INTJ" },
  { id: "e2e-06", query: "用户的主目标是什么？", expected: "一人公司创业者" },
  { id: "e2e-07", query: "用户的健康目标是什么？", expected: "保持健康体重" },
  { id: "e2e-08", query: "用户当前的全职工作是什么？", expected: "某互联网公司程序员" },
  { id: "e2e-09", query: "用户正在探索哪个媒体方向？", expected: "自媒体" },
  { id: "e2e-10", query: "用户正在探索哪种移动端开发？", expected: "iOS开发" },
  { id: "e2e-11", query: "用户正在探索哪种游戏相关方向？", expected: "游戏开发" },
  { id: "e2e-12", query: "用户正在探索哪种开放协作方向？", expected: "开源项目" },
  { id: "e2e-13", query: "用户最重要的关系对象是谁？", expected: "伴侣" },
  { id: "e2e-14", query: "用户偏好的沟通风格是什么？", expected: "平静、专业、直击要害" },
  { id: "e2e-15", query: "用户偏好的表达方式是什么？", expected: "金字塔" },
  { id: "e2e-16", query: "用户一天里什么时候最高效？", expected: "上午和晚上" },
  { id: "e2e-17", query: "用户偏好什么沟通方式？", expected: "异步沟通" },
  { id: "e2e-18", query: "用户讨厌什么类型的 AI 表达？", expected: "AI 客套话" },
  { id: "e2e-19", query: "turning_zero 对用户来说是什么角色？", expected: "数字外脑与首席幕僚" },
  { id: "e2e-20", query: "turning_zero 在缺乏数据时应该怎么做？", expected: "调用工具检索" },
  { id: "e2e-21", query: "turning_zero 遵循什么思考方法？", expected: "第一性原理" },
  { id: "e2e-22", query: "turning_zero 的隐私原则是什么？", expected: "隐私保护" },
  { id: "e2e-23", query: "turning_zero 对删除操作的默认要求是什么？", expected: "trash" },
  { id: "e2e-24", query: "turning_zero 对外部行动的默认要求是什么？", expected: "确认" },
  { id: "e2e-25", query: "smart-router 分类器现在是什么模型？", expected: "gemini-3.1-flash-lite-preview" },
  { id: "e2e-26", query: "memU retrieve 优化时 route_intention 是什么状态？", expected: "关闭" },
  { id: "e2e-27", query: "memU retrieve 优化时 sufficiency_check 是什么状态？", expected: "关闭" },
  { id: "e2e-28", query: "memU retrieve 优化时 resource 检索是什么状态？", expected: "关闭" },
  { id: "e2e-29", query: "memU embedding 现在用什么模型？", expected: "nomic-embed-text" },
  { id: "e2e-30", query: "nomic-embed-text 的向量维度是多少？", expected: "768" },
  { id: "e2e-31", query: "Gemini embedding-001 的向量维度是多少？", expected: "3072" },
  { id: "e2e-32", query: "memU-server 优化后 retrieve 的 P95 延迟是多少？", expected: "120ms" },
  { id: "e2e-33", query: "memU-server 优化后的月费用大概是多少？", expected: "0 美元" },
  { id: "e2e-34", query: "memory-memu 把 retrieve 超时调整到了多少？", expected: "5000ms" },
  { id: "e2e-35", query: "memory-memu 的 cbResetMs 配置是多少？", expected: "10000ms" },
  { id: "e2e-36", query: "目标记忆架构一共有几层？", expected: "四层" },
  { id: "e2e-37", query: "目标记忆架构的第1层是什么？", expected: "JSONL 全量对话日志" },
  { id: "e2e-38", query: "目标记忆架构的第2层是什么？", expected: "可搜索的长期记忆" },
  { id: "e2e-39", query: "目标记忆架构的第3层是什么？", expected: "Core Memory K/V" },
  { id: "e2e-40", query: "目标记忆架构的第4层是什么？", expected: "context compaction" },
];

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const results: E2EResult[] = [];

  console.log(`Running ${CASES.length} live end-to-end recall cases...`);
  for (const [index, item] of CASES.entries()) {
    const message = `请只用一句中文回答：${item.query}`;
    const started = Date.now();
    const answer = await runAgentQuery(message);
    const durationMs = Date.now() - started;
    const hit = includesExpected(answer, item.expected);
    results.push({ id: item.id, query: item.query, expected: item.expected, answer, hit, durationMs });
    console.log(`[${index + 1}/${CASES.length}] ${item.id} hit=${hit ? "Y" : "N"} ${durationMs}ms`);
  }

  const summary = {
    cases: results.length,
    hits: results.filter((row) => row.hit).length,
    hitRate: Number((results.filter((row) => row.hit).length / results.length).toFixed(3)),
    avgDurationMs: Math.round(results.reduce((sum, row) => sum + row.durationMs, 0) / Math.max(results.length, 1)),
    p95DurationMs: percentile(results.map((row) => row.durationMs), 0.95),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    summary,
    failures: results.filter((row) => !row.hit),
    results,
  };

  const reportPath = `/tmp/turning-zero-e2e-benchmark-${runId}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("");
  console.log("Summary");
  console.log("═══════");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report: ${reportPath}`);
}

async function runAgentQuery(message: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "openclaw",
    ["agent", "--agent", "turning_zero", "--message", message, "--timeout", "45", "--json"],
    { cwd: "~/.openclaw", maxBuffer: 4 * 1024 * 1024 },
  );
  const payload = extractTrailingJson(stdout);
  const parsed = JSON.parse(payload);
  return String(parsed?.result?.payloads?.[0]?.text ?? "").trim();
}

function extractTrailingJson(stdout: string): string {
  const start = stdout.lastIndexOf("\n{");
  if (start >= 0) return stdout.slice(start + 1).trim();
  const brace = stdout.indexOf("{");
  if (brace >= 0) return stdout.slice(brace).trim();
  throw new Error(`No JSON payload found in output: ${stdout.slice(0, 200)}`);
}

function includesExpected(answer: string, expected: string): boolean {
  const normalizedAnswer = normalize(answer);
  const normalizedExpected = normalize(expected);
  return normalizedExpected.length > 0 && normalizedAnswer.includes(normalizedExpected);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、“”"'`·:：；;（）()【】\[\]\-]/g, "");
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
