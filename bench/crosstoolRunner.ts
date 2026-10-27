import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import * as dotenv from "dotenv";
import { listDirTool, readFileTool, grepTool, estimateTokens, ToolResult } from "./tools/baselineTools.js";
import { OSSAnalyserAdapter } from "./adapters/ossAnalyserAdapter.js";
import {
  GoldFact,
  BenchmarkTask,
  FactGrade,
  buildTaskJudgePrompt,
  validateAndNormalizeFactGrade
} from "./auditedGrader.js";

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY && process.env.NODE_ENV !== "test") {
  console.error("Error: GEMINI_API_KEY environment variable is required.");
  process.exit(1);
}

const MODEL_NAME = "gemini-3.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

// Cost constants for Gemini 3.5 Flash Lite
const PRICE_PROMPT_PER_M = 0.075;
const PRICE_COMPLETION_PER_M = 0.30;

export interface FreezeManifest {
  manifestVersion: string;
  freezeTimestamp: string;
  rubricPath: string;
  rubricSha256: string;
  auditedGraderPath: string;
  auditedGraderSha256: string;
  tasksCount: number;
  goldFactsCount: number;
  rubricVersion: string;
}

export interface ArmRunResult {
  sessionId: string;
  repetition: number;
  arm: "baseline" | "graphify" | "oss_analyser";
  taskId: string;
  question: string;
  timestamp: string;
  turns: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  toolContextTokens: number;
  costUSD: number | null;
  durationMs: number;
  toolCallsCount: Record<string, number>;
  auditedCoverage: number;
  auditedGrades: FactGrade[];
  legacyCoverage?: number;
  legacyGrades?: FactGrade[];
  finalAnswer: string;
  evaluatorDurationMs?: number;
  evaluatorPromptTokens?: number | null;
  evaluatorCompletionTokens?: number | null;
  evaluatorTotalTokens?: number | null;
}

export interface ArmAggregateStats {
  meanCoverage: number;
  medianCoverage: number;
  meanTokens: number | null;
  medianTokens: number | null;
  unavailableTokenSessions: number;
  meanTurns: number;
  totalCost: number | null;
  unavailableCostSessions: number;
  meanDuration: number;
}

export interface BenchmarkRunnerOptions {
  runDir?: string;
  repetitions?: number;
  tasks?: BenchmarkTask[];
  freezeManifestPath?: string;
  skipAdapterInit?: boolean;
  interArmPacingMs?: number;
  toolPacingMs?: number;
  agentCaller?: (reqBody: any) => Promise<any>;
  judgeCaller?: (reqBody: any) => Promise<any>;
}

export function computeMedian(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0
    ? Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10
    : s[mid];
}

export function computeStats(runs: ArmRunResult[]): ArmAggregateStats {
  if (runs.length === 0) {
    return {
      meanCoverage: 0,
      medianCoverage: 0,
      meanTokens: null,
      medianTokens: null,
      unavailableTokenSessions: 0,
      meanTurns: 0,
      totalCost: null,
      unavailableCostSessions: 0,
      meanDuration: 0
    };
  }

  const coverages = runs.map((r) => r.auditedCoverage);
  const turns = runs.map((r) => r.turns);
  const durations = runs.map((r) => r.durationMs);

  const validTokens = runs
    .map((r) => r.totalTokens)
    .filter((t): t is number => typeof t === "number");
  const unavailableTokenSessions = runs.filter((r) => r.totalTokens === null).length;

  const validCosts = runs
    .map((r) => r.costUSD)
    .filter((c): c is number => typeof c === "number");
  const unavailableCostSessions = runs.filter((r) => r.costUSD === null).length;

  const meanCoverage = coverages.reduce((a, b) => a + b, 0) / coverages.length;
  const medianCoverage = computeMedian(coverages);
  const meanTurns = Math.round((turns.reduce((a, b) => a + b, 0) / turns.length) * 10) / 10;
  const meanDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);

  const meanTokens =
    validTokens.length > 0
      ? Math.round(validTokens.reduce((a, b) => a + b, 0) / validTokens.length)
      : null;

  const medianTokens =
    validTokens.length > 0
      ? computeMedian(validTokens)
      : null;

  const totalCost =
    validCosts.length > 0
      ? Math.round(validCosts.reduce((a, b) => a + b, 0) * 100000) / 100000
      : null;

  return {
    meanCoverage: Math.round(meanCoverage * 10) / 10,
    medianCoverage,
    meanTokens,
    medianTokens,
    unavailableTokenSessions,
    meanTurns,
    totalCost,
    unavailableCostSessions,
    meanDuration
  };
}

export function generateSessionId(repetition: number, taskId: string, arm: string): string {
  return `rep${repetition}_${taskId}_${arm}`;
}

export function verifyFreezeIntegrity(
  manifestPath = path.resolve(process.cwd(), "bench", "rubrics", "RUBRIC_FREEZE.json")
): FreezeManifest {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Freeze manifest not found: ${manifestPath}. Cannot run benchmark without verified frozen rubric and evaluator.`
    );
  }

  const manifest: FreezeManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const rubricPath = path.resolve(process.cwd(), manifest.rubricPath || "bench/rubrics/starlette_rubric.json");
  const graderPath = path.resolve(process.cwd(), manifest.auditedGraderPath || "bench/auditedGrader.ts");

  if (!fs.existsSync(rubricPath)) {
    throw new Error(`Rubric file not found at expected path: ${rubricPath}`);
  }
  if (!fs.existsSync(graderPath)) {
    throw new Error(`Audited grader file not found at expected path: ${graderPath}`);
  }

  const actualRubricSha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(rubricPath))
    .digest("hex");
  const actualGraderSha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(graderPath))
    .digest("hex");

  if (actualRubricSha256 !== manifest.rubricSha256) {
    throw new Error(
      `Rubric SHA-256 mismatch!\n  Expected: ${manifest.rubricSha256}\n  Actual:   ${actualRubricSha256}\nRubric has been altered since freeze. Aborting benchmark.`
    );
  }

  if (actualGraderSha256 !== manifest.auditedGraderSha256) {
    throw new Error(
      `Audited grader SHA-256 mismatch!\n  Expected: ${manifest.auditedGraderSha256}\n  Actual:   ${actualGraderSha256}\nAudited grader has been altered since freeze. Aborting benchmark.`
    );
  }

  return manifest;
}

export function createSafeRunDirectory(
  baseDir = path.resolve(process.cwd(), "bench", "results", "runs"),
  timestampOverride?: string
): string {
  let ts = timestampOverride;
  if (!ts) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  const runDir = path.join(baseDir, `run_${ts}`);
  if (fs.existsSync(runDir)) {
    throw new Error(`Run directory already exists: ${runDir}. Aborting to prevent data overwrite.`);
  }

  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

async function callGeminiWithRetry(reqBody: any, maxRetries = 5): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(GEMINI_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody)
      });
      const data = await res.json();

      if (data.error && data.error.code === 429) {
        const msg = data.error.message || "";
        if (msg.includes("per day") || msg.includes("PerDay") || msg.includes("free_tier_requests")) {
          throw new Error(`[Daily Quota Exceeded] ${msg}`);
        }

        let waitSec = 16;
        const retryInfo = data.error.details?.find((d: any) => d["@type"]?.includes("RetryInfo"));
        if (retryInfo?.retryDelay) {
          const parsed = parseInt(String(retryInfo.retryDelay).replace("s", ""), 10);
          if (!isNaN(parsed)) {
            if (parsed > 60) {
              throw new Error(`[Quota Delay Exceeded] Retry delay is ${parsed}s (> 1 minute): ${msg}`);
            }
            waitSec = parsed + 2;
          }
        } else {
          const match = msg.match(/retry in ([\d.]+)s/i);
          if (match) {
            waitSec = Math.ceil(parseFloat(match[1])) + 2;
          }
        }

        process.stdout.write(
          `    [429 Quota Exceeded] Backing off for ${waitSec}s (attempt ${attempt + 1}/${maxRetries})...\n`
        );
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }

      return data;
    } catch (err: any) {
      if (err.message.includes("[Daily Quota Exceeded]") || err.message.includes("[Quota Delay Exceeded]")) {
        throw err;
      }
      process.stdout.write(`    [Network Error] ${err.message}. Retrying in 5s...\n`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return null;
}

export async function judgeSessionAnswer(
  task: BenchmarkTask,
  answer: string,
  judgeCaller?: (reqBody: any) => Promise<any>
): Promise<{
  coverage: number;
  grades: FactGrade[];
  durationMs: number;
  prompt: string;
  evaluatorPromptTokens?: number | null;
  evaluatorCompletionTokens?: number | null;
  evaluatorTotalTokens?: number | null;
}> {
  const evalStart = Date.now();
  const prompt = buildTaskJudgePrompt(task, answer);

  const reqBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  };

  const caller = judgeCaller || callGeminiWithRetry;
  const data = await caller(reqBody);

  let evaluatorPromptTokens: number | null = null;
  let evaluatorCompletionTokens: number | null = null;
  let evaluatorTotalTokens: number | null = null;

  if (data?.usageMetadata) {
    if (typeof data.usageMetadata.promptTokenCount === "number") {
      evaluatorPromptTokens = data.usageMetadata.promptTokenCount;
    }
    if (typeof data.usageMetadata.candidatesTokenCount === "number") {
      evaluatorCompletionTokens = data.usageMetadata.candidatesTokenCount;
    }
    if (evaluatorPromptTokens !== null && evaluatorCompletionTokens !== null) {
      evaluatorTotalTokens = evaluatorPromptTokens + evaluatorCompletionTokens;
    } else if (evaluatorPromptTokens !== null) {
      evaluatorTotalTokens = evaluatorPromptTokens;
    } else if (evaluatorCompletionTokens !== null) {
      evaluatorTotalTokens = evaluatorCompletionTokens;
    }
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  let judgeItems: any[] = [];
  try {
    if (text) {
      judgeItems = JSON.parse(text);
    }
  } catch (err) {
    console.warn(`    [Judge Warning] Failed to parse judge JSON: ${err}`);
  }

  const itemsMap = new Map<string, any>();
  if (Array.isArray(judgeItems)) {
    judgeItems.forEach((it) => itemsMap.set(it.factId, it));
  }

  const grades: FactGrade[] = [];
  for (const gf of task.goldFacts) {
    const item = itemsMap.get(gf.id);
    const grade = validateAndNormalizeFactGrade(gf, answer, item);
    grades.push({
      ...grade,
      reverificationPrompt: prompt
    });
  }

  const totalScore = grades.reduce((acc, g) => acc + g.score, 0);
  const coverage = Math.round((totalScore / task.goldFacts.length) * 1000) / 10;
  const durationMs = Date.now() - evalStart;

  return {
    coverage,
    grades,
    durationMs,
    prompt,
    evaluatorPromptTokens,
    evaluatorCompletionTokens,
    evaluatorTotalTokens
  };
}

async function gradeWithFactVerification(
  answer: string,
  goldFacts: GoldFact[]
): Promise<{ coverage: number; grades: FactGrade[] }> {
  const grades: FactGrade[] = [];
  const lowerAnswer = answer.toLowerCase();

  for (const gf of goldFacts) {
    let matchedKeywords = 0;
    const matchedWords: string[] = [];
    for (const kw of gf.keywords) {
      if (lowerAnswer.includes(kw.toLowerCase())) {
        matchedKeywords++;
        matchedWords.push(kw);
      }
    }

    const matchRatio = matchedKeywords / gf.keywords.length;
    let verdict: "COVERED" | "PARTIAL" | "NOT_COVERED" = "NOT_COVERED";
    let score = 0.0;

    if (matchRatio >= 0.75) {
      verdict = "COVERED";
      score = 1.0;
    } else if (matchRatio >= 0.35) {
      verdict = "PARTIAL";
      score = 0.5;
    } else {
      verdict = "NOT_COVERED";
      score = 0.0;
    }

    let citation = "";
    if (verdict !== "NOT_COVERED") {
      const sentences = answer.split(/\r?\n|\.\s+/);
      let bestSentence = "";
      let maxOverlap = 0;
      for (const sent of sentences) {
        const sentLower = sent.toLowerCase();
        let overlap = 0;
        for (const kw of gf.keywords) {
          if (sentLower.includes(kw.toLowerCase())) overlap++;
        }
        if (overlap > maxOverlap) {
          maxOverlap = overlap;
          bestSentence = sent.trim();
        }
      }
      citation = bestSentence ? `"${bestSentence.slice(0, 160)}..."` : `Keywords: [${matchedWords.join(", ")}]`;
    } else {
      citation = "(no matching context found in answer)";
    }

    grades.push({
      factId: gf.id,
      fact: gf.fact,
      verdict,
      score,
      citation
    });
  }

  const totalScore = grades.reduce((acc, g) => acc + g.score, 0);
  const coverage = Math.round((totalScore / goldFacts.length) * 1000) / 10;
  return { coverage, grades };
}

function callGraphifyTool(graphPath: string, question: string, budget = 2000): ToolResult {
  try {
    const scriptPath = path.resolve(process.cwd(), "bench", "adapters", "graphifyAdapter.py");
    const out = execFileSync("python", [scriptPath, graphPath, question, String(budget)], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024
    });
    return { content: out, tokens: estimateTokens(out) };
  } catch (err: any) {
    return { content: `Error invoking Graphify: ${err.message}`, tokens: 10 };
  }
}

export async function runAgentSession(
  arm: "baseline" | "graphify" | "oss_analyser",
  task: BenchmarkTask,
  repoRoot: string,
  graphifyPath: string,
  ossAdapter: OSSAnalyserAdapter,
  repetition = 1,
  maxTurns = 8,
  agentCaller?: (reqBody: any) => Promise<any>,
  judgeCaller?: (reqBody: any) => Promise<any>,
  toolPacingMs = 4000
): Promise<ArmRunResult> {
  const sessionId = generateSessionId(repetition, task.id, arm);
  const timestamp = new Date().toISOString();
  const startTime = Date.now();
  const toolCallsCount: Record<string, number> = {};
  let hasReportedPromptTokens = false;
  let hasReportedCompletionTokens = false;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let toolContextTokens = 0;
  let turns = 0;
  let finalAnswer = "";

  const baselineTools = [
    {
      name: "grep",
      description: "Search file lines across the codebase matching a regex or substring pattern.",
      parameters: {
        type: "OBJECT",
        properties: {
          pattern: { type: "STRING", description: "Regex or substring pattern to search" },
          path_prefix: { type: "STRING", description: "Optional directory path to restrict search" }
        },
        required: ["pattern"]
      }
    },
    {
      name: "read_file",
      description: "Read a bounded slice of lines from a file in the repository.",
      parameters: {
        type: "OBJECT",
        properties: {
          file_path: { type: "STRING", description: "Relative file path from repository root" },
          offset: { type: "INTEGER", description: "1-based starting line number (default 1)" },
          limit: { type: "INTEGER", description: "Maximum number of lines to read (default 100, max 200)" }
        },
        required: ["file_path"]
      }
    },
    {
      name: "list_dir",
      description: "List files and subdirectories in a target directory.",
      parameters: {
        type: "OBJECT",
        properties: {
          dir_path: { type: "STRING", description: "Relative directory path (default .)" }
        }
      }
    }
  ];

  const functionDeclarations: any[] = [];
  let systemInstruction = "";

  if (arm === "baseline") {
    functionDeclarations.push(...baselineTools);
    systemInstruction = `You are a principal software engineering agent analyzing the codebase to answer architectural and code-mechanism questions.
Use grep, list_dir, and read_file to investigate the repository. Cite exact file paths, class names, function names, and ASGI lifecycle mechanisms in your final answer.
Deliver your final comprehensive technical answer in markdown.`;
  } else if (arm === "graphify") {
    functionDeclarations.push({
      name: "query_graph",
      description: "Search the knowledge graph using Graphify BFS/DFS traversal. Returns relevant nodes, source locations, and edges. Use this tool FIRST to understand the architectural landscape before reading specific files.",
      parameters: {
        type: "OBJECT",
        properties: {
          question: { type: "STRING", description: "Natural language query or keywords" },
          token_budget: { type: "INTEGER", description: "Max output tokens (default 2000)" }
        },
        required: ["question"]
      }
    });
    functionDeclarations.push(...baselineTools);
    systemInstruction = `You are a principal software engineering agent analyzing the codebase.
You have access to 'query_graph' (Graphify knowledge graph). Call 'query_graph' FIRST to discover the relevant symbols, files, and relationships. Use read_file only if you need to inspect an exact code implementation line.
Cite exact file paths, class names, function names, and ASGI mechanisms in your final markdown answer.`;
  } else if (arm === "oss_analyser") {
    functionDeclarations.push({
      name: "query_code_graph",
      description: "Query OSS Analyser's structural code graph. Returns extracted symbols, signatures, docstrings, file contracts, and dependency call edges. Use this tool FIRST to retrieve the relevant architectural context in one shot.",
      parameters: {
        type: "OBJECT",
        properties: {
          question: { type: "STRING", description: "Natural language query or architectural concept" },
          token_budget: { type: "INTEGER", description: "Max output tokens (default 2000)" }
        },
        required: ["question"]
      }
    });
    functionDeclarations.push(...baselineTools);
    systemInstruction = `You are a principal software engineering agent analyzing the codebase.
You have access to 'query_code_graph' (OSS Analyser structural graph). Call 'query_code_graph' FIRST to retrieve extracted symbols, signatures, contracts, and call graph edges in one shot. Use read_file only if you need to inspect specific file lines.
Cite exact file paths, class names, function names, and ASGI mechanisms in your final markdown answer.`;
  }

  const contents: any[] = [
    {
      role: "user",
      parts: [
        {
          text: `Investigate and answer the following question about the repository:\n\n${task.question}\n\nBe specific and cite exact symbols and files.`
        }
      ]
    }
  ];

  const caller = agentCaller || callGeminiWithRetry;

  for (let turn = 0; turn < maxTurns; turn++) {
    turns++;

    const isPenultimateOrFinal = turn >= maxTurns - 1;
    const activeTools = isPenultimateOrFinal ? [] : [{ functionDeclarations }];

    if (isPenultimateOrFinal) {
      contents.push({
        role: "user",
        parts: [
          {
            text: "You have gathered sufficient context from your tool calls. Do NOT call any more tools. Formulate and deliver your final comprehensive technical answer in markdown now."
          }
        ]
      });
    }

    const reqBody: any = {
      contents,
      systemInstruction: { parts: [{ text: systemInstruction }] }
    };
    if (activeTools.length > 0) {
      reqBody.tools = activeTools;
    }

    const data = await caller(reqBody);

    if (data?.usageMetadata) {
      if (typeof data.usageMetadata.promptTokenCount === "number") {
        totalPromptTokens += data.usageMetadata.promptTokenCount;
        hasReportedPromptTokens = true;
      }
      if (typeof data.usageMetadata.candidatesTokenCount === "number") {
        totalCompletionTokens += data.usageMetadata.candidatesTokenCount;
        hasReportedCompletionTokens = true;
      }
    }

    const candidate = data?.candidates?.[0];
    if (!candidate || !candidate.content) {
      console.warn(`No candidate returned on turn ${turns} for ${sessionId}`);
      break;
    }

    const parts = candidate.content.parts || [];
    const functionCallPart = parts.find((p: any) => p.functionCall);

    if (functionCallPart && functionCallPart.functionCall && !isPenultimateOrFinal) {
      const { name, args } = functionCallPart.functionCall;
      toolCallsCount[name] = (toolCallsCount[name] || 0) + 1;

      let toolRes: ToolResult = { content: "", tokens: 0 };
      if (name === "grep") {
        toolRes = grepTool(repoRoot, args.pattern || "", args.path_prefix);
      } else if (name === "read_file") {
        toolRes = readFileTool(repoRoot, args.file_path || args.path || "", args.offset, args.limit);
      } else if (name === "list_dir") {
        toolRes = listDirTool(repoRoot, args.dir_path || args.path);
      } else if (name === "query_graph" && arm === "graphify") {
        toolRes = callGraphifyTool(graphifyPath, args.question || "", args.token_budget || 2000);
      } else if (name === "query_code_graph" && arm === "oss_analyser") {
        const text = await ossAdapter.queryCodeGraph(args.question || "", args.token_budget || 2000);
        toolRes = { content: text, tokens: estimateTokens(text) };
      } else {
        toolRes = { content: `Error: Tool "${name}" is unknown or not permitted for arm "${arm}".`, tokens: 5 };
      }

      toolContextTokens += toolRes.tokens;
      process.stdout.write(`  [${sessionId}] Turn ${turns}: tool ${name} (${toolRes.tokens} tok)\n`);

      contents.push(candidate.content);
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name,
              response: { result: toolRes.content }
            }
          }
        ]
      });

      // Pacing to remain strictly below 15 RPM free tier limit
      if (toolPacingMs > 0) {
        await new Promise((r) => setTimeout(r, toolPacingMs));
      }
    } else {
      const textPart = parts.find((p: any) => p.text);
      finalAnswer = textPart?.text || "";
      process.stdout.write(`  [${sessionId}] Turn ${turns}: Final answer delivered (${estimateTokens(finalAnswer)} tok)\n`);
      break;
    }
  }

  const durationMs = Date.now() - startTime;

  const promptTokens: number | null = hasReportedPromptTokens ? totalPromptTokens : null;
  const completionTokens: number | null = hasReportedCompletionTokens ? totalCompletionTokens : null;
  const totalTokens: number | null =
    promptTokens !== null && completionTokens !== null
      ? promptTokens + completionTokens
      : promptTokens !== null
        ? promptTokens
        : completionTokens !== null
          ? completionTokens
          : null;

  const costUSD: number | null =
    promptTokens !== null && completionTokens !== null
      ? (promptTokens * PRICE_PROMPT_PER_M + completionTokens * PRICE_COMPLETION_PER_M) / 1000000
      : null;

  // Authoritative Substantive Model-Judge Evaluation
  const {
    coverage: auditedCoverage,
    grades: auditedGrades,
    durationMs: evaluatorDurationMs,
    evaluatorPromptTokens,
    evaluatorCompletionTokens,
    evaluatorTotalTokens
  } = await judgeSessionAnswer(task, finalAnswer, judgeCaller);

  // Diagnostic Legacy Keyword Evaluation
  const { coverage: legacyCoverage, grades: legacyGrades } =
    await gradeWithFactVerification(finalAnswer, task.goldFacts);

  return {
    sessionId,
    repetition,
    arm,
    taskId: task.id,
    question: task.question,
    timestamp,
    turns,
    promptTokens,
    completionTokens,
    totalTokens,
    toolContextTokens,
    costUSD,
    durationMs,
    toolCallsCount,
    auditedCoverage,
    auditedGrades,
    legacyCoverage,
    legacyGrades,
    finalAnswer,
    evaluatorDurationMs,
    evaluatorPromptTokens,
    evaluatorCompletionTokens,
    evaluatorTotalTokens
  };
}

export async function runFullBenchmark(options?: BenchmarkRunnerOptions): Promise<string> {
  // 1. Fail-Fast Freeze Integrity Verification
  const freezeManifest = verifyFreezeIntegrity(options?.freezeManifestPath);
  console.log(`\n✓ Freeze integrity verified against manifest: ${freezeManifest.freezeTimestamp}`);
  console.log(`  - Rubric SHA-256:  ${freezeManifest.rubricSha256}`);
  console.log(`  - Grader SHA-256:  ${freezeManifest.auditedGraderSha256}`);

  // 2. Safe Unique Run Directory Creation or Resuming
  let runDir = options?.runDir;
  let isResumed = false;
  if (!runDir && process.env.BENCH_RESUME_DIR) {
    const requested = process.env.BENCH_RESUME_DIR.trim();
    const runsBase = path.resolve(process.cwd(), "bench", "results", "runs");
    if (requested.toLowerCase() === "latest") {
      if (!fs.existsSync(runsBase)) {
        throw new Error(`Runs directory does not exist: ${runsBase}`);
      }
      const existingRuns = fs
        .readdirSync(runsBase)
        .filter((d) => d.startsWith("run_") && fs.statSync(path.join(runsBase, d)).isDirectory())
        .sort()
        .reverse();
      if (existingRuns.length === 0) {
        throw new Error(`No existing run directories found in ${runsBase} to resume.`);
      }
      runDir = path.join(runsBase, existingRuns[0]);
    } else {
      const candidate1 = path.resolve(process.cwd(), requested);
      const candidate2 = path.join(runsBase, requested);
      if (fs.existsSync(candidate1)) {
        runDir = candidate1;
      } else if (fs.existsSync(candidate2)) {
        runDir = candidate2;
      } else {
        throw new Error(`Resume directory not found: ${requested}`);
      }
    }
    isResumed = true;
    console.log(`✓ Resuming existing run from: ${runDir}`);
  } else if (!runDir) {
    runDir = createSafeRunDirectory();
  }

  fs.mkdirSync(runDir, { recursive: true });
  console.log(`✓ Using run directory: ${runDir}`);

  // 3. Load Rubric Tasks
  const rubricPath = path.resolve(process.cwd(), freezeManifest.rubricPath || "bench/rubrics/starlette_rubric.json");
  const rubricData = JSON.parse(fs.readFileSync(rubricPath, "utf-8"));
  const allRubricTasks: BenchmarkTask[] = rubricData.tasks;
  const availableTaskIds = new Set(allRubricTasks.map((t) => t.id));

  let tasks: BenchmarkTask[] = options?.tasks || allRubricTasks;
  if (!options?.tasks && process.env.BENCH_TASKS) {
    const requestedIds = process.env.BENCH_TASKS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (requestedIds.length === 0) {
      throw new Error("BENCH_TASKS environment variable was provided but contained no valid task IDs.");
    }

    const invalidIds = requestedIds.filter((id) => !availableTaskIds.has(id));
    if (invalidIds.length > 0) {
      throw new Error(
        `Invalid task ID(s) in BENCH_TASKS: ${invalidIds.join(", ")}. Available task IDs: ${Array.from(availableTaskIds).join(", ")}`
      );
    }

    tasks = requestedIds.map((id) => allRubricTasks.find((t) => t.id === id)!);
  }

  const repetitions = options?.repetitions || parseInt(process.env.BENCH_REPETITIONS || "1", 10) || 1;
  const arms: Array<"baseline" | "graphify" | "oss_analyser"> = ["baseline", "graphify", "oss_analyser"];
  const totalExpectedSessions = repetitions * tasks.length * arms.length;

  // 4. Record Run Manifest
  let gitCommit = "unknown";
  try {
    gitCommit = execSync("git rev-parse HEAD", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {}

  const runnerPath = path.resolve(process.cwd(), "bench", "crosstoolRunner.ts");
  const runnerSha256 = fs.existsSync(runnerPath)
    ? crypto.createHash("sha256").update(fs.readFileSync(runnerPath)).digest("hex")
    : "unknown";

  const manifestPath = path.join(runDir, "run_manifest.json");
  let originalStartedAt = new Date().toISOString();
  if (fs.existsSync(manifestPath)) {
    try {
      const existingManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      if (existingManifest.runStartedAt) {
        originalStartedAt = existingManifest.runStartedAt;
      }
    } catch {}
  }

  const runManifest: any = {
    runDirectory: runDir,
    runStartedAt: originalStartedAt,
    ...(isResumed ? { resumedAt: new Date().toISOString() } : {}),
    gitCommit,
    rubricVersion: freezeManifest.rubricVersion,
    rubricSha256: freezeManifest.rubricSha256,
    auditedGraderSha256: freezeManifest.auditedGraderSha256,
    runnerSha256,
    agentModel: MODEL_NAME,
    evaluatorModel: MODEL_NAME,
    evaluatorTemperature: 0.1,
    taskCount: tasks.length,
    goldFactCount: freezeManifest.goldFactsCount,
    repetitionsCount: repetitions,
    totalExpectedSessions,
    arms,
    sessionOrdering: "For rep in 1..repetitions: for task in tasks: for arm in [baseline, graphify, oss_analyser]"
  };

  fs.writeFileSync(manifestPath, JSON.stringify(runManifest, null, 2), "utf-8");
  console.log(`✓ Run manifest recorded at: ${manifestPath}`);

  console.log(`\n========================================================================`);
  console.log(`  REPLICATING GRAPHIFY CROSSTOOL BENCHMARK (MULTI-REPETITION SUITE)`);
  console.log(`  Configurations:`);
  console.log(`    Arm 1: Baseline Floor (grep, read_file, list_dir)`);
  console.log(`    Arm 2: Baseline + Graphify (query_graph BFS/DFS)`);
  console.log(`    Arm 3: Baseline + OSS Analyser (query_code_graph Hybrid RRF: BM25 + sqlite-vec + AST Graph)`);
  console.log(`  Model         : ${MODEL_NAME}`);
  console.log(`  Target Repo   : encode/starlette`);
  console.log(`  Questions (n) : ${tasks.length}`);
  console.log(`  Repetitions   : ${repetitions}`);
  console.log(`  Total Sessions: ${totalExpectedSessions} sessions`);
  console.log(`  Max Turns     : 8 per question (with auto-synthesis on final turn)`);
  console.log(`  Authoritative : Substantive Audited Ground-Truth Model Judge`);
  console.log(`========================================================================\n`);

  const rawDir = path.resolve(process.env.BENCH_RAW_DIR || "C:\\Users\\pvsra\\kirat\\benchmark\\starlette-raw");
  const graphifyDir = path.resolve(process.env.BENCH_GRAPHIFY_DIR || "C:\\Users\\pvsra\\kirat\\benchmark\\starlette-graphify");
  const ossDir = path.resolve(process.env.BENCH_OSS_DIR || "C:\\Users\\pvsra\\kirat\\benchmark\\starlette-ossAnalyser");
  const graphifyPath = path.resolve(graphifyDir, "graphify-out", "graph.json");

  const ossAdapter = new OSSAnalyserAdapter(ossDir);
  if (!options?.skipAdapterInit) {
    await ossAdapter.init();
  }

  const interArmPacingMs = options?.interArmPacingMs ?? 4500;
  const toolPacingMs = options?.toolPacingMs ?? 4000;

  const allSessionResults: ArmRunResult[] = [];

  try {
    for (let rep = 1; rep <= repetitions; rep++) {
      const repRawPath = path.join(runDir, `rep${rep}_raw_results.json`);
      const repAuditedPath = path.join(runDir, `rep${rep}_audited_results.json`);

      // Check if this repetition was already completed and saved on disk
      if (fs.existsSync(repRawPath) && fs.existsSync(repAuditedPath)) {
        try {
          const savedRuns: ArmRunResult[] = JSON.parse(fs.readFileSync(repRawPath, "utf-8"));
          if (Array.isArray(savedRuns) && savedRuns.length === tasks.length * arms.length) {
            console.log(`\n========================================================================`);
            console.log(`  REPETITION ${rep} / ${repetitions} ALREADY COMPLETED (Restored from disk)`);
            console.log(`  ✓ Restored all ${savedRuns.length} completed sessions from: ${repRawPath}`);
            console.log(`========================================================================\n`);
            allSessionResults.push(...savedRuns);
            continue;
          }
        } catch (err) {
          console.warn(`  [Resume Warning] Could not parse rep${rep} results, re-running...`);
        }
      }

      console.log(`\n========================================================================`);
      console.log(`  REPETITION ${rep} / ${repetitions} IN PROGRESS`);
      console.log(`========================================================================\n`);

      const repResults: ArmRunResult[] = [];

      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        console.log(`\n------------------------------------------------------------------------`);
        console.log(`[Rep ${rep}/${repetitions}] Question ${i + 1}/${tasks.length}: "${task.question}"`);
        console.log(`------------------------------------------------------------------------`);

        for (const arm of arms) {
          const repoDir = arm === "baseline" ? rawDir : arm === "graphify" ? graphifyDir : ossDir;
          console.log(`\n▶ [Rep ${rep}] Arm: ${arm.toUpperCase()}...`);

          const result = await runAgentSession(
            arm,
            task,
            repoDir,
            graphifyPath,
            ossAdapter,
            rep,
            8,
            options?.agentCaller,
            options?.judgeCaller,
            toolPacingMs
          );

          repResults.push(result);
          allSessionResults.push(result);
          console.log(
            `  ✓ [${result.sessionId}] Audited Coverage: ${result.auditedCoverage}%, Turns: ${result.turns}, Tokens: ${result.totalTokens ?? "N/A"}, Agent Latency: ${(result.durationMs / 1000).toFixed(1)}s, Judge Latency: ${((result.evaluatorDurationMs || 0) / 1000).toFixed(1)}s`
          );

          if (interArmPacingMs > 0) {
            await new Promise((r) => setTimeout(r, interArmPacingMs));
          }
        }
      }

      // Immediately save this repetition's completed results
      fs.writeFileSync(repRawPath, JSON.stringify(repResults, null, 2), "utf-8");

      const repAuditedData = repResults.map((r) => ({
        sessionId: r.sessionId,
        repetition: r.repetition,
        arm: r.arm,
        taskId: r.taskId,
        question: r.question,
        auditedCoverage: r.auditedCoverage,
        auditedGrades: r.auditedGrades,
        legacyCoverage: r.legacyCoverage,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        totalTokens: r.totalTokens,
        costUSD: r.costUSD,
        durationMs: r.durationMs,
        evaluatorDurationMs: r.evaluatorDurationMs,
        evaluatorPromptTokens: r.evaluatorPromptTokens,
        evaluatorCompletionTokens: r.evaluatorCompletionTokens,
        evaluatorTotalTokens: r.evaluatorTotalTokens
      }));
      fs.writeFileSync(repAuditedPath, JSON.stringify(repAuditedData, null, 2), "utf-8");

      console.log(`\n✓ Repetition ${rep} complete. Results safely saved:`);
      console.log(`   - Raw answers & tokens: ${repRawPath}`);
      console.log(`   - Audited grades & citations: ${repAuditedPath}`);
    }
  } catch (err: any) {
    console.error(`\n❌ Benchmark run interrupted by error: ${err.message}`);
    const failureRecord = {
      interruptedAt: new Date().toISOString(),
      completedSessionsCount: allSessionResults.length,
      totalExpectedSessions,
      errorMessage: err.message,
      stack: err.stack
    };
    fs.writeFileSync(path.join(runDir, "partial_failure.json"), JSON.stringify(failureRecord, null, 2), "utf-8");
    console.error(`✓ Completed sessions preserved safely in ${runDir}. Partial failure recorded.`);
    throw err;
  } finally {
    if (!options?.skipAdapterInit) {
      await ossAdapter.close();
    }
  }

  // Clear partial failure marker if all repetitions completed successfully
  const partialFailurePath = path.join(runDir, "partial_failure.json");
  if (fs.existsSync(partialFailurePath)) {
    try {
      fs.unlinkSync(partialFailurePath);
    } catch {}
  }

  // 5. Aggregate Across Repetitions
  const runsByArm: Record<string, ArmRunResult[]> = {
    baseline: allSessionResults.filter((r) => r.arm === "baseline"),
    graphify: allSessionResults.filter((r) => r.arm === "graphify"),
    oss_analyser: allSessionResults.filter((r) => r.arm === "oss_analyser")
  };

  const s1 = computeStats(runsByArm.baseline);
  const s2 = computeStats(runsByArm.graphify);
  const s3 = computeStats(runsByArm.oss_analyser);

  const aggregatedSummary = {
    runDirectory: runDir,
    completedAt: new Date().toISOString(),
    totalSessions: allSessionResults.length,
    repetitions,
    armsSummary: {
      baseline: s1,
      graphify: s2,
      oss_analyser: s3
    },
    allSessions: allSessionResults
  };

  fs.writeFileSync(
    path.join(runDir, "aggregated_audited_results.json"),
    JSON.stringify(aggregatedSummary, null, 2),
    "utf-8"
  );

  const formatTokens = (stat: ArmAggregateStats, totalRuns: number) => {
    if (stat.meanTokens === null) {
      return `*N/A (${stat.unavailableTokenSessions}/${totalRuns} unavail)*`;
    }
    if (stat.unavailableTokenSessions > 0) {
      return `${stat.meanTokens} *(${totalRuns - stat.unavailableTokenSessions}/${totalRuns} avail)*`;
    }
    return `${stat.meanTokens}`;
  };

  const formatCost = (stat: ArmAggregateStats, totalRuns: number) => {
    if (stat.totalCost === null) {
      return `*N/A (${stat.unavailableCostSessions}/${totalRuns} unavail)*`;
    }
    if (stat.unavailableCostSessions > 0) {
      return `$${stat.totalCost} *(${totalRuns - stat.unavailableCostSessions}/${totalRuns} avail)*`;
    }
    return `$${stat.totalCost}`;
  };

  // 6. Generate Markdown Report in the run directory
  const reportPath = path.join(runDir, "BENCHMARK_REPORT.md");
  let reportMd = `# Graphify vs OSS Analyser: Multi-Repetition Audited Benchmark Report

Replication of the Graphify \`crosstool\` Code Intelligence Benchmark on production codebase [encode/starlette](https://github.com/encode/starlette).
- **Tasks ($n$)**: ${tasks.length} tasks
- **Repetitions**: ${repetitions} repetitions
- **Total Evaluated Sessions**: ${allSessionResults.length} sessions
- **Authoritative Grading**: Substantive Ground-Truth Model Judge (temperature 0.1) with verbatim evidence validation.
- **Rubric Version**: ${freezeManifest.rubricVersion} (SHA-256: \`${freezeManifest.rubricSha256.slice(0, 16)}...\`)
- **Audited Grader SHA-256**: \`${freezeManifest.auditedGraderSha256.slice(0, 16)}...\`

---

## 1. Overall Audited Performance (Aggregated Across ${repetitions} Repetitions)

| Configuration | Mean Audited Coverage | Median Audited Coverage | Mean Tokens / Query | Mean Turns | Total Spend (USD) | Mean Latency / Session |
|---|---|---|---|---|---|---|
| **Arm 1: Baseline Floor** (\`grep\`/\`read\`/\`list\`) | **${s1.meanCoverage}%** | **${s1.medianCoverage}%** | **${formatTokens(s1, runsByArm.baseline.length)}** | **${s1.meanTurns}** | **${formatCost(s1, runsByArm.baseline.length)}** | **${(s1.meanDuration / 1000).toFixed(1)}s** |
| **Arm 2: + Graphify** (\`query_graph\`) | **${s2.meanCoverage}%** | **${s2.medianCoverage}%** | **${formatTokens(s2, runsByArm.graphify.length)}** | **${s2.meanTurns}** | **${formatCost(s2, runsByArm.graphify.length)}** | **${(s2.meanDuration / 1000).toFixed(1)}s** |
| **Arm 3: + OSS Analyser** (\`query_code_graph\`) | **${s3.meanCoverage}%** | **${s3.medianCoverage}%** | **${formatTokens(s3, runsByArm.oss_analyser.length)}** | **${s3.meanTurns}** | **${formatCost(s3, runsByArm.oss_analyser.length)}** | **${(s3.meanDuration / 1000).toFixed(1)}s** |

---

## 2. Per-Task Audited Coverage Across Repetitions

| Task ID | Question | Baseline Mean Coverage | + Graphify Mean Coverage | + OSS Analyser Mean Coverage | Δ (OSS vs Baseline) | Δ (OSS vs Graphify) |
|---|---|---|---|---|---|---|
`;

  for (const t of tasks) {
    const bRuns = allSessionResults.filter((r) => r.taskId === t.id && r.arm === "baseline");
    const gRuns = allSessionResults.filter((r) => r.taskId === t.id && r.arm === "graphify");
    const oRuns = allSessionResults.filter((r) => r.taskId === t.id && r.arm === "oss_analyser");

    const bMean = bRuns.length ? Math.round((bRuns.reduce((a, b) => a + b.auditedCoverage, 0) / bRuns.length) * 10) / 10 : 0;
    const gMean = gRuns.length ? Math.round((gRuns.reduce((a, b) => a + b.auditedCoverage, 0) / gRuns.length) * 10) / 10 : 0;
    const oMean = oRuns.length ? Math.round((oRuns.reduce((a, b) => a + b.auditedCoverage, 0) / oRuns.length) * 10) / 10 : 0;

    const dBase = (oMean - bMean >= 0 ? "+" : "") + (oMean - bMean).toFixed(1) + "%";
    const dGraph = (oMean - gMean >= 0 ? "+" : "") + (oMean - gMean).toFixed(1) + "%";

    reportMd += `| \`${t.id}\` | ${t.question.slice(0, 48)}... | ${bMean}% | ${gMean}% | ${oMean}% | **${dBase}** | **${dGraph}** |\n`;
  }

  reportMd += `
---

## 3. Session Reproducibility Log

Every session in this benchmark is preserved with full raw answers, token usage, verbatim citations, and auditor justifications:
- Raw answers: \`rep*_raw_results.json\`
- Audited grades: \`rep*_audited_results.json\`
- Aggregated dataset: \`aggregated_audited_results.json\`

*Report generated by \`bench/crosstoolRunner.ts\` on ${new Date().toISOString()}*.
`;

  fs.writeFileSync(reportPath, reportMd, "utf-8");
  console.log(`\n✓ Multi-repetition benchmark report generated at: ${reportPath}\n`);

  return runDir;
}

// Auto-run if executed directly
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  runFullBenchmark().catch((err) => {
    console.error("Fatal benchmark error:", err);
    process.exit(1);
  });
}
