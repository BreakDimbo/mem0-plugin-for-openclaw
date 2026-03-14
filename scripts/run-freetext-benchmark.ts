import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import { loadConfig, type MemoryScope } from "../types.js";
import { MemUClient } from "../client.js";
import { MemUAdapter } from "../adapter.js";
import { Mem0FreeTextBackend } from "../backends/free-text/mem0.js";
import { MemUFreeTextBackend } from "../backends/free-text/memu.js";

type BenchmarkCase = {
  id: string;
  fact: string;
  query: string;
  expected: string;
};

type BackendEval = {
  top1Hit: boolean;
  top5Hit: boolean;
  top1?: string;
  top5: string[];
};

type CaseResult = {
  id: string;
  query: string;
  expected: string;
  mem0: BackendEval;
  memu: BackendEval;
};

const CASES: BenchmarkCase[] = [
  { id: "01", fact: "The user consistently prefers jasmine tea over coffee.", query: "What drink does the user prefer?", expected: "jasmine tea" },
  { id: "02", fact: "The user's preferred editor is Neovim.", query: "Which editor does the user prefer?", expected: "neovim" },
  { id: "03", fact: "The user's home timezone is UTC+8.", query: "What timezone does the user use?", expected: "utc+8" },
  { id: "04", fact: "The user protects 7:00 AM to 9:00 AM for deep work every weekday.", query: "When is the user's deep work block?", expected: "7:00 am to 9:00 am" },
  { id: "05", fact: "The user plays badminton every Friday night.", query: "When does the user play badminton?", expected: "friday night" },
  { id: "06", fact: "The user does not take phone calls before 10:00 AM.", query: "Before what time does the user avoid phone calls?", expected: "10:00 am" },
  { id: "07", fact: "The user uses Python for data pipelines.", query: "Which language does the user use for data pipelines?", expected: "python" },
  { id: "08", fact: "The user's primary database is PostgreSQL.", query: "What is the user's primary database?", expected: "postgresql" },
  { id: "09", fact: "The user's preferred JavaScript package manager is pnpm.", query: "Which package manager does the user prefer for JavaScript?", expected: "pnpm" },
  { id: "10", fact: "The user writes unit tests before large refactors.", query: "What does the user do before large refactors?", expected: "unit tests" },
  { id: "11", fact: "The user's partner lives in Xi'an.", query: "Where does the user's partner live?", expected: "xi'an" },
  { id: "12", fact: "The user works from the Singapore office.", query: "Which office does the user work from?", expected: "singapore office" },
  { id: "13", fact: "The user's reading goal is four books each month.", query: "What is the user's monthly reading goal?", expected: "four books" },
  { id: "14", fact: "The user does meal prep every Sunday evening.", query: "When does the user do meal prep?", expected: "sunday evening" },
  { id: "15", fact: "The user dislikes cilantro.", query: "What herb does the user dislike?", expected: "cilantro" },
  { id: "16", fact: "The user's laptop is a 14-inch MacBook Pro.", query: "What laptop does the user use?", expected: "14-inch macbook pro" },
  { id: "17", fact: "The user works with two Dell 27-inch monitors.", query: "What monitors does the user use?", expected: "two dell 27-inch monitors" },
  { id: "18", fact: "The user's default shell is zsh.", query: "What is the user's default shell?", expected: "zsh" },
  { id: "19", fact: "The user's main note-taking app is Obsidian.", query: "Which note-taking app does the user use?", expected: "obsidian" },
  { id: "20", fact: "The user's default git branch is main.", query: "What is the user's default git branch?", expected: "main" },
  { id: "21", fact: "The user prefers concise bullet summaries.", query: "What style of summary does the user prefer?", expected: "concise bullet summaries" },
  { id: "22", fact: "The user never runs destructive git commands without approval.", query: "What git safety rule does the user follow?", expected: "without approval" },
  { id: "23", fact: "The user's CI provider is GitHub Actions.", query: "Which CI provider does the user use?", expected: "github actions" },
  { id: "24", fact: "The user's task tracker is Linear.", query: "Which task tracker does the user use?", expected: "linear" },
  { id: "25", fact: "Project documentation lives in the docs directory.", query: "Where does project documentation live?", expected: "docs directory" },
  { id: "26", fact: "The user manages meetings in Feishu Calendar.", query: "Which calendar tool does the user use?", expected: "feishu calendar" },
  { id: "27", fact: "The user's main cloud provider is AWS.", query: "Which cloud provider does the user use?", expected: "aws" },
  { id: "28", fact: "The user's staging region is ap-southeast-1.", query: "What is the user's staging region?", expected: "ap-southeast-1" },
  { id: "29", fact: "The user prefers UTC timestamps in logs.", query: "What timestamp format does the user prefer in logs?", expected: "utc timestamps" },
  { id: "30", fact: "The user uses Ruff for Python linting.", query: "Which Python linter does the user use?", expected: "ruff" },
  { id: "31", fact: "The user uses Biome for JavaScript formatting.", query: "Which formatter does the user use for JavaScript?", expected: "biome" },
  { id: "32", fact: "The user keeps pull requests under 400 lines whenever possible.", query: "How large does the user like pull requests to be?", expected: "under 400 lines" },
  { id: "33", fact: "The user's code reviews focus on bugs first.", query: "What is the user's first priority in code reviews?", expected: "bugs first" },
  { id: "34", fact: "The user runs retrospectives every Friday afternoon.", query: "When does the user run retrospectives?", expected: "friday afternoon" },
  { id: "35", fact: "The user reviews the monthly budget on the first business day of the month.", query: "When does the user review the monthly budget?", expected: "first business day" },
  { id: "36", fact: "The user prefers a dark terminal theme.", query: "What terminal theme does the user prefer?", expected: "dark terminal theme" },
  { id: "37", fact: "The user's keyboard layout is US English.", query: "What keyboard layout does the user use?", expected: "us english" },
  { id: "38", fact: "The user's main browser is Arc.", query: "Which browser does the user mainly use?", expected: "arc" },
  { id: "39", fact: "The user's personal site is built with Astro.", query: "What framework is the user's personal site built with?", expected: "astro" },
  { id: "40", fact: "Research newsletters are stored in the research/newsletters folder.", query: "Where are research newsletters stored?", expected: "research/newsletters" },
  { id: "41", fact: "The user usually flies between Singapore and Xi'an.", query: "Which route does the user usually fly?", expected: "singapore and xi'an" },
  { id: "42", fact: "The user drinks sparkling water on flights.", query: "What does the user drink on flights?", expected: "sparkling water" },
  { id: "43", fact: "The user runs backups every night at 2:00 AM.", query: "When does the user run backups?", expected: "2:00 am" },
  { id: "44", fact: "The user stores secrets in 1Password.", query: "Where does the user store secrets?", expected: "1password" },
  { id: "45", fact: "The user prefers Mermaid for diagrams.", query: "Which diagram format does the user prefer?", expected: "mermaid" },
  { id: "46", fact: "The user uses MSW for API mocks.", query: "Which tool does the user use for API mocks?", expected: "msw" },
  { id: "47", fact: "The user's phone is an iPhone 15.", query: "What phone does the user use?", expected: "iphone 15" },
  { id: "48", fact: "The user's expense tracking currency is SGD.", query: "Which currency does the user use for expenses?", expected: "sgd" },
  { id: "49", fact: "The user uses a tab width of 2 for JavaScript files.", query: "What tab width does the user use for JavaScript?", expected: "tab width of 2" },
  { id: "50", fact: "The user's preferred Python environment tool is uv.", query: "Which Python environment tool does the user prefer?", expected: "uv" },
];

async function main() {
  const raw = JSON.parse(fs.readFileSync("~/.openclaw/openclaw.json", "utf-8"));
  const cfg = loadConfig(raw.plugins.entries["memory-memu"].config);
  const logger = console;
  const client = new MemUClient(cfg.memu.baseUrl, cfg.memu.timeoutMs, cfg.memu.healthCheckPath, logger);
  const adapter = new MemUAdapter(client, cfg, logger);
  const mem0 = new Mem0FreeTextBackend(cfg, logger);
  const memu = new MemUFreeTextBackend(adapter, () => client.healthCheck());

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const scope: MemoryScope = {
    userId: `benchmark.user.${runId}`,
    agentId: "benchmark_agent",
    sessionKey: `agent:benchmark_agent:${runId}`,
  };

  console.log(`Benchmark scope: user=${scope.userId} agent=${scope.agentId} session=${scope.sessionKey}`);
  console.log(`Seeding ${CASES.length} facts into mem0 and memu...`);

  for (const [index, item] of CASES.entries()) {
    const [okMem0, okMemu] = await Promise.all([
      storeWithRetry(mem0, item.fact, scope, item.id),
      storeWithRetry(memu, item.fact, scope, item.id),
    ]);
    if (!okMem0 || !okMemu) {
      throw new Error(`Failed to seed benchmark case ${item.id}: mem0=${okMem0} memu=${okMemu}`);
    }
    if ((index + 1) % 10 === 0 || index === CASES.length - 1) {
      console.log(`  Seeded ${index + 1}/${CASES.length}`);
    }
  }

  const results: CaseResult[] = [];
  console.log(`Running ${CASES.length} retrieval checks...`);
  for (const [index, item] of CASES.entries()) {
    const [mem0Results, memuResults] = await Promise.all([
      withTimeout(
        mem0.search(item.query, scope, { maxItems: 5, includeSessionScope: true }),
        20_000,
        `mem0 search timeout for case ${item.id}`,
      ),
      withTimeout(
        memu.search(item.query, scope, { maxItems: 5 }),
        20_000,
        `memu search timeout for case ${item.id}`,
      ),
    ]);
    results.push({
      id: item.id,
      query: item.query,
      expected: item.expected,
      mem0: evaluate(mem0Results, item.expected),
      memu: evaluate(memuResults, item.expected),
    });
    if ((index + 1) % 10 === 0 || index === CASES.length - 1) {
      console.log(`  Evaluated ${index + 1}/${CASES.length}`);
    }
  }

  const summary = {
    cases: results.length,
    mem0: summarize(results.map((item) => item.mem0)),
    memu: summarize(results.map((item) => item.memu)),
    scope,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    summary,
    failures: {
      mem0Top1Misses: results.filter((item) => !item.mem0.top1Hit).slice(0, 10),
      memuTop1Misses: results.filter((item) => !item.memu.top1Hit).slice(0, 10),
      mem0Top5Misses: results.filter((item) => !item.mem0.top5Hit).slice(0, 10),
      memuTop5Misses: results.filter((item) => !item.memu.top5Hit).slice(0, 10),
    },
  };

  const reportPath = `/tmp/memory-memu-benchmark-${runId}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("");
  console.log("Summary");
  console.log("═══════");
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log(`Detailed report: ${reportPath}`);
}

function evaluate(results: Array<{ text: string }>, expected: string): BackendEval {
  const normalizedExpected = expected.trim().toLowerCase();
  const top5 = results.map((item) => item.text);
  const top1 = top5[0];
  return {
    top1,
    top5,
    top1Hit: Boolean(top1 && top1.toLowerCase().includes(normalizedExpected)),
    top5Hit: top5.some((item) => item.toLowerCase().includes(normalizedExpected)),
  };
}

function summarize(rows: BackendEval[]) {
  return {
    top1Hits: rows.filter((row) => row.top1Hit).length,
    top5Hits: rows.filter((row) => row.top5Hit).length,
    top1Rate: Number((rows.filter((row) => row.top1Hit).length / rows.length).toFixed(3)),
    top5Rate: Number((rows.filter((row) => row.top5Hit).length / rows.length).toFixed(3)),
  };
}

async function storeWithRetry(
  backend: { store(text: string, scope: MemoryScope, options?: { metadata?: Record<string, unknown> }): Promise<boolean>; provider: string },
  text: string,
  scope: MemoryScope,
  caseId: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ok = await withTimeout(
      backend.store(text, scope, {
        metadata: { capture_kind: "explicit", benchmark_case: caseId, benchmark_attempt: attempt },
      }),
      25_000,
      `${backend.provider} store timeout for case ${caseId} attempt ${attempt}`,
    );
    if (ok) return true;
    await sleep(250 * attempt);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
