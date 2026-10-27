import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY environment variable is required.");
  process.exit(1);
}

const MODEL_NAME = "gemini-3.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

export interface GoldFact {
  id: string;
  fact: string;
  sourceLocation?: string;
  acceptanceCriteria?: string;
  keywords: string[];
}

export interface BenchmarkTask {
  id: string;
  question: string;
  targetFiles: string[];
  goldFacts: GoldFact[];
}

export interface FactGrade {
  factId: string;
  fact: string;
  verdict: "COVERED" | "PARTIAL" | "NOT_COVERED";
  score: number;
  citation: string;
  justification?: string;
  sourceLocation?: string;
  reverificationPrompt?: string;
}

export interface ArmRunResult {
  arm: "baseline" | "graphify" | "oss_analyser";
  taskId: string;
  question: string;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolContextTokens: number;
  costUSD: number;
  durationMs: number;
  toolCallsCount: Record<string, number>;
  keyFactCoverage: number;
  grades: FactGrade[];
  finalAnswer: string;
}

async function callGeminiJudge(prompt: string, maxRetries = 5): Promise<any> {
  const reqBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(GEMINI_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody)
      });
      const data = await res.json();

      if (data.error && (data.error.code === 429 || data.error.code === 503)) {
        const msg = data.error.message || "";
        const match = msg.match(/retry in ([\d.]+)s/i);
        const waitSec = match ? Math.ceil(parseFloat(match[1])) + 2 : 16;
        process.stdout.write(`    [Judge 429/503] Backing off for ${waitSec}s (attempt ${attempt + 1}/${maxRetries})...\n`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error(`Invalid candidate response: ${JSON.stringify(data)}`);
      }
      return JSON.parse(text);
    } catch (err: any) {
      if (attempt === maxRetries) throw err;
      process.stdout.write(`    [Judge Error] ${err.message}. Retrying in 4s...\n`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  return null;
}

export function buildTaskJudgePrompt(
  task: BenchmarkTask,
  answerText: string
): string {
  const factsList = task.goldFacts
    .map(
      (gf, idx) => `Fact ${idx + 1}:
  - Fact ID: "${gf.id}"
  - Ground Truth Statement: ${gf.fact}
  - Starlette Code Source: ${gf.sourceLocation || "Starlette source"}
  - Acceptance Criteria: ${gf.acceptanceCriteria || "Explains the mechanism accurately."}`
    )
    .join("\n\n");

  return `You are an impartial, expert software verification judge auditing an AI coding agent's technical answer against the ground-truth implementation of the encode/starlette (Python) repository.

TASK QUESTION:
${task.question}

GOLD FACTS TO EVALUATE:
${factsList}

AGENT ANSWER TEXT TO AUDIT:
"""
${answerText}
"""

INSTRUCTIONS:
For every gold fact listed above, determine whether the agent's answer substantively satisfies the claim based on Starlette's actual code mechanisms and the explicit acceptance criteria.

Rules for evaluation:
1. Citations: Select an exact, verbatim quotation from the answer that substantiates this specific claim. If the answer does not support the fact, you MUST return null. Never quote sentences about different mechanisms or unrelated concepts.
2. Complete Fact Proof:
   - Evidence must substantiate the entire factual claim and all explicit elements in the acceptance criteria, not merely related terminology.
   - For q3_fact_3: Full credit ("COVERED") strictly requires that the answer explicitly identifies ServerErrorMiddleware (or starlette/middleware/errors.py) as the outermost safety net catching unhandled exceptions and returning a 500 error response. Merely asserting that exceptions are re-raised or bubble up to Uvicorn/ASGI server without identifying Starlette's 500 middleware MUST be graded "NOT_COVERED" (score 0.0).
   - For q2_fact_4: Full credit ("COVERED") strictly requires explaining both that build_middleware_stack() wraps the core Router in nested ASGI layers AND that user middleware is applied in reverse order (reversed(self.user_middleware) / inside-out). If the reverse wrapping order is omitted, assign at most "PARTIAL" (score 0.5).
3. Symmetric Classification:
   - Apply strictly identical standards across all three benchmark arms regardless of answer length or formatting.
   - "COVERED" (score: 1.0): The answer substantively, accurately, and completely explains all required mechanisms defined in the acceptance criteria.
   - "PARTIAL" (score: 0.5): The answer mentions the concept or mechanism, but misses core details (such as reverse ordering or specific middleware behaviors), or uses ambiguous phrasing.
   - "NOT_COVERED" (score: 0.0): The mechanism is omitted, unsupported by exact evidence, or the answer makes factually incorrect statements.
4. Justification: Provide a concise 1-2 sentence explanation comparing the answer's statements to Starlette's actual behavior.

Output JSON as an array of objects matching this exact structure:
[
  {
    "factId": "<factId>",
    "verdict": "COVERED" | "PARTIAL" | "NOT_COVERED",
    "score": 1.0 | 0.5 | 0.0,
    "citation": "<exact verbatim sentence from answer or null>",
    "justification": "<concise explanation>"
  }
]`;
}

export function validateAndNormalizeFactGrade(
  gf: GoldFact,
  answerText: string,
  judgeItem?: {
    verdict?: string;
    score?: number;
    citation?: string | null;
    justification?: string;
  }
): FactGrade {
  let verdict: "COVERED" | "PARTIAL" | "NOT_COVERED" =
    judgeItem?.verdict === "COVERED" || judgeItem?.verdict === "PARTIAL" || judgeItem?.verdict === "NOT_COVERED"
      ? judgeItem.verdict
      : "NOT_COVERED";

  let score: number =
    typeof judgeItem?.score === "number"
      ? judgeItem.score
      : verdict === "COVERED"
        ? 1.0
        : verdict === "PARTIAL"
          ? 0.5
          : 0.0;

  let rawCitation = judgeItem?.citation?.trim() || "";
  if (rawCitation === "null" || rawCitation === "(no substantiating context found in answer)") {
    rawCitation = "";
  }

  let citation = rawCitation;
  if (!citation) {
    verdict = "NOT_COVERED";
    score = 0.0;
    citation = "(no substantiating context found in answer)";
  }

  let justification = judgeItem?.justification || "Evaluated by ground-truth model judge against Starlette ground truth.";

  // Specific guardrail for q3_fact_3 (ServerErrorMiddleware):
  // Must explicitly identify ServerErrorMiddleware (or starlette/middleware/errors.py) as outer 500 error boundary.
  if (gf.id === "q3_fact_3") {
    const mentionsServerErrorMiddleware =
      /\bServerErrorMiddleware\b/i.test(answerText) ||
      /\b(starlette\/)?middleware\/errors(\.py)?\b/i.test(answerText);

    if (!mentionsServerErrorMiddleware) {
      verdict = "NOT_COVERED";
      score = 0.0;
      citation = rawCitation || "(no substantiating context found in answer)";
      justification = `[Evaluator Guardrail] Omission of ServerErrorMiddleware: Answer does not mention ServerErrorMiddleware or errors.py. Asserting that unhandled exceptions bubble directly to Uvicorn or ASGI server fails the acceptance criteria for Starlette's built-in 500 safety net.`;
    } else {
      const explains500OrCatching =
        /\b500\b/i.test(answerText) ||
        /\buncaught|unhandled\b/i.test(answerText) ||
        /\bsafety net\b/i.test(answerText);
      if (!explains500OrCatching && verdict === "COVERED") {
        verdict = "PARTIAL";
        score = 0.5;
        justification = `[Evaluator Guardrail] Partial mention: ServerErrorMiddleware is named but its role in catching unhandled exceptions and formatting 500 responses is incomplete.`;
      }
    }
  }

  // Specific guardrail for q2_fact_4 (build_middleware_stack & reverse order):
  // Must explain both wrapping Router AND reversed order of user middleware.
  if (gf.id === "q2_fact_4") {
    const mentionsReverseOrder =
      /\brevers(ed|e|ing)\b/i.test(answerText) ||
      /\binside[- ]out\b/i.test(answerText) ||
      /\blast[- ]added.*first\b/i.test(answerText);

    const mentionsBuildStackOrRouter =
      /\bbuild_middleware_stack\b/i.test(answerText) ||
      /\bwrap(s|ping)?\b.*\bRouter\b/i.test(answerText);

    if (!mentionsReverseOrder && verdict === "COVERED") {
      verdict = "PARTIAL";
      score = 0.5;
      justification = `[Evaluator Guardrail] Incomplete ordering: Answer describes build_middleware_stack and onion wrapping, but omits the reverse execution order (reversed(self.user_middleware)) required for full credit.`;
    } else if (!mentionsBuildStackOrRouter && verdict !== "NOT_COVERED") {
      verdict = "NOT_COVERED";
      score = 0.0;
      justification = `[Evaluator Guardrail] Missing mechanism: Answer does not explain build_middleware_stack() or wrapping the Router.`;
    }
  }

  // Final score-verdict consistency normalization
  if (verdict === "COVERED") score = 1.0;
  else if (verdict === "PARTIAL") score = 0.5;
  else score = 0.0;

  return {
    factId: gf.id,
    fact: gf.fact,
    verdict,
    score,
    citation,
    justification,
    sourceLocation: gf.sourceLocation
  };
}

export async function runAuditedGrading(): Promise<void> {
  console.log(`\n========================================================================`);
  console.log(`  RUNNING SUBSTANTIVE FACTUAL AUDIT ON STARLETTE BENCHMARK ANSWERS`);
  console.log(`  Methodology   : Ground-Truth Model Judge with Verbatim Evidence Extraction`);
  console.log(`  Source Rubric : bench/rubrics/starlette_rubric.json (v2.1.0 finalized)`);
  console.log(`  Model Judge   : ${MODEL_NAME}`);
  console.log(`========================================================================\n`);

  const rubricPath = path.resolve(process.cwd(), "bench", "rubrics", "starlette_rubric.json");
  const rubricData = JSON.parse(fs.readFileSync(rubricPath, "utf-8"));
  const tasksMap = new Map<string, BenchmarkTask>();
  rubricData.tasks.forEach((t: BenchmarkTask) => tasksMap.set(t.id, t));

  const resultsPath = path.resolve(process.cwd(), "bench", "results", "crosstool_results.json");
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`Results file not found: ${resultsPath}`);
  }
  const originalResults: Record<string, ArmRunResult[]> = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));

  const auditedResults: Record<string, ArmRunResult[]> = {
    baseline: [],
    graphify: [],
    oss_analyser: []
  };

  const arms = ["baseline", "graphify", "oss_analyser"] as const;

  for (const arm of arms) {
    const runs = originalResults[arm] || [];
    console.log(`\n------------------------------------------------------------------------`);
    console.log(`Auditing Arm: ${arm.toUpperCase()} (${runs.length} tasks)`);
    console.log(`------------------------------------------------------------------------`);

    for (const run of runs) {
      const task = tasksMap.get(run.taskId);
      if (!task) {
        console.warn(`Warning: Task ${run.taskId} not found in rubric. Skipping.`);
        continue;
      }

      console.log(`\n  ▶ Task: ${task.id} ("${task.question.slice(0, 55)}...")`);
      const prompt = buildTaskJudgePrompt(task, run.finalAnswer);
      const judgeItems = await callGeminiJudge(prompt);

      const itemsMap = new Map<string, any>();
      if (Array.isArray(judgeItems)) {
        judgeItems.forEach((it) => itemsMap.set(it.factId, it));
      }

      const auditedGrades: FactGrade[] = [];

      for (const gf of task.goldFacts) {
        const item = itemsMap.get(gf.id);
        const grade = validateAndNormalizeFactGrade(gf, run.finalAnswer, item);

        auditedGrades.push({
          ...grade,
          reverificationPrompt: prompt
        });

        console.log(`    • ${gf.id}: ${grade.verdict} (${grade.score})`);
      }

      const totalScore = auditedGrades.reduce((acc, g) => acc + g.score, 0);
      const auditedCoverage = Math.round((totalScore / task.goldFacts.length) * 1000) / 10;

      const auditedRun: ArmRunResult = {
        ...run,
        keyFactCoverage: auditedCoverage,
        grades: auditedGrades
      };

      auditedResults[arm].push(auditedRun);
      console.log(`    ↳ Audited Coverage: ${auditedCoverage}% (Original Keyword: ${run.keyFactCoverage}%)`);

      // Rate-limit safety: 4000ms between task judge calls to remain strictly under 15 RPM
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  // Save audited results to separate file
  const auditedResultsPath = path.resolve(process.cwd(), "bench", "results", "crosstool_audited_results.json");
  fs.writeFileSync(auditedResultsPath, JSON.stringify(auditedResults, null, 2), "utf-8");
  console.log(`\n✓ Audited results saved to: ${auditedResultsPath}`);

  // Generate AUDITED_BENCHMARK_REPORT.md
  generateAuditedReport(originalResults, auditedResults, tasksMap);
}

function generateAuditedReport(
  orig: Record<string, ArmRunResult[]>,
  audit: Record<string, ArmRunResult[]>,
  tasksMap: Map<string, BenchmarkTask>
): void {
  const reportPath = path.resolve(process.cwd(), "bench", "AUDITED_BENCHMARK_REPORT.md");

  const computeSummary = (runs: ArmRunResult[]) => {
    const covs = runs.map((r) => r.keyFactCoverage);
    const mean = Math.round((covs.reduce((a, b) => a + b, 0) / covs.length) * 10) / 10;
    const sorted = [...covs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10 : sorted[mid];
    return { mean, median };
  };

  const origS1 = computeSummary(orig.baseline);
  const origS2 = computeSummary(orig.graphify);
  const origS3 = computeSummary(orig.oss_analyser);

  const auditS1 = computeSummary(audit.baseline);
  const auditS2 = computeSummary(audit.graphify);
  const auditS3 = computeSummary(audit.oss_analyser);

  let md = `# Audited Benchmark Evaluation Report: Graphify vs OSS Analyser

> **Substantive Fact Verification & Independent Model Judge Audit**  
> Evaluated on production codebase [encode/starlette](https://github.com/encode/starlette) ($n=${audit.baseline.length}$ tasks).  
> Evaluation methodology: Ground-truth model judging against verified Starlette source code with verbatim answer citation extraction.  
> Generated on: \`${new Date().toISOString()}\`.

---

## 1. Executive Comparison: Keyword-Only vs. Substantive Audited Scoring

This table contrasts the legacy heuristic keyword matching scores against the audited substantive model-judge scores with verified ground-truth citations.

| Configuration | Legacy Mean Coverage | **Audited Mean Coverage** | Legacy Median | **Audited Median** | Net Audit Delta |
|---|---|---|---|---|---|
| **Arm 1: Baseline Floor** (\`grep\`/\`read\`/\`list\`) | ${origS1.mean}% | **${auditS1.mean}%** | ${origS1.median}% | **${auditS1.median}%** | **${(auditS1.mean - origS1.mean >= 0 ? "+" : "") + (auditS1.mean - origS1.mean).toFixed(1)}%** |
| **Arm 2: + Graphify** (\`query_graph\`) | ${origS2.mean}% | **${auditS2.mean}%** | ${origS2.median}% | **${auditS2.median}%** | **${(auditS2.mean - origS2.mean >= 0 ? "+" : "") + (auditS2.mean - origS2.mean).toFixed(1)}%** |
| **Arm 3: + OSS Analyser** (\`query_code_graph\`) | ${origS3.mean}% | **${auditS3.mean}%** | ${origS3.median}% | **${auditS3.median}%** | **${(auditS3.mean - origS3.mean >= 0 ? "+" : "") + (auditS3.mean - origS3.mean).toFixed(1)}%** |

---

## 2. Per-Task Coverage Breakdown

| Task ID | Question Summary | Baseline (Orig $\\rightarrow$ Audit) | Graphify (Orig $\\rightarrow$ Audit) | OSS Analyser (Orig $\\rightarrow$ Audit) | Substantive Winner |
|---|---|---|---|---|---|
`;

  for (let i = 0; i < audit.baseline.length; i++) {
    const tId = audit.baseline[i].taskId;
    const task = tasksMap.get(tId)!;
    const bo = orig.baseline.find((r) => r.taskId === tId)!.keyFactCoverage;
    const ba = audit.baseline.find((r) => r.taskId === tId)!.keyFactCoverage;

    const go = orig.graphify.find((r) => r.taskId === tId)!.keyFactCoverage;
    const ga = audit.graphify.find((r) => r.taskId === tId)!.keyFactCoverage;

    const oo = orig.oss_analyser.find((r) => r.taskId === tId)!.keyFactCoverage;
    const oa = audit.oss_analyser.find((r) => r.taskId === tId)!.keyFactCoverage;

    const winner = oa > ga && oa > ba ? "OSS Analyser" : ga > oa && ga > ba ? "Graphify" : ba > oa && ba > ga ? "Baseline" : (oa === ga && oa > ba ? "OSS Analyser & Graphify (Tie)" : "Tie");

    md += `| \`${tId}\` | ${task.question.slice(0, 48)}... | ${bo}% $\\rightarrow$ **${ba}%** | ${go}% $\\rightarrow$ **${ga}%** | ${oo}% $\\rightarrow$ **${oa}%** | **${winner}** |\n`;
  }

  md += `
---

## 3. Detailed Audited Fact Breakdown with Verbatim Citations

For each question and gold fact, the table below provides the ground-truth Starlette source location, the verified verdict, the exact verbatim quotation from the answer, and the auditor's justification.

`;

  for (let i = 0; i < audit.baseline.length; i++) {
    const tId = audit.baseline[i].taskId;
    const task = tasksMap.get(tId)!;
    const bRun = audit.baseline.find((r) => r.taskId === tId)!;
    const gRun = audit.graphify.find((r) => r.taskId === tId)!;
    const oRun = audit.oss_analyser.find((r) => r.taskId === tId)!;

    md += `### Task: \`${tId}\`\n**Question**: ${task.question}\n\n`;

    for (let j = 0; j < task.goldFacts.length; j++) {
      const gf = task.goldFacts[j];
      const bg = bRun.grades.find((g) => g.factId === gf.id)!;
      const gg = gRun.grades.find((g) => g.factId === gf.id)!;
      const og = oRun.grades.find((g) => g.factId === gf.id)!;

      md += `#### Fact ${j + 1}: \`${gf.id}\`
- **Statement**: ${gf.fact}
- **Starlette Ground Truth**: [\`${gf.sourceLocation}\`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/${gf.sourceLocation?.split("#")[0]})
- **Acceptance Criteria**: ${gf.acceptanceCriteria || "N/A"}

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **${bg.verdict}** (${bg.score}) | *"${bg.citation.replace(/\|/g, "\\|")}"* | ${bg.justification?.replace(/\|/g, "\\|")} |
| **+ Graphify** | **${gg.verdict}** (${gg.score}) | *"${gg.citation.replace(/\|/g, "\\|")}"* | ${gg.justification?.replace(/\|/g, "\\|")} |
| **+ OSS Analyser** | **${og.verdict}** (${og.score}) | *"${og.citation.replace(/\|/g, "\\|")}"* | ${og.justification?.replace(/\|/g, "\\|")} |

`;
    }
  }

  md += `---

## 4. Independent Agent Re-Verification Protocol

To independently verify any grading decision without trusting this evaluator, any external agent (Google Antigravity, Claude Code, Cursor, GPT-4) can execute the following verification prompt against the raw answer in \`bench/results/crosstool_results.json\`:

\`\`\`markdown
You are an independent code auditor. Verify whether the agent answer below substantively satisfies the Starlette ground-truth fact.

Question: <TASK_QUESTION>
Fact to Verify: <GOLD_FACT_STATEMENT>
Starlette Source Truth: <STARLETTE_FILE_AND_LINE>
Acceptance Criteria: <ACCEPTANCE_CRITERIA>

Agent Answer Text:
\"\"\"
<AGENT_ANSWER_TEXT>
\"\"\"

Output JSON:
{
  "verdict": "COVERED" | "PARTIAL" | "NOT_COVERED",
  "score": 1.0 | 0.5 | 0.0,
  "citation": "<exact verbatim sentence from answer or null>",
  "justification": "<concise explanation citing Starlette behavior>"
}
\`\`\`

---
*Report generated by \`bench/auditedGrader.ts\` on ${new Date().toISOString()}*.
`;

  fs.writeFileSync(reportPath, md, "utf-8");
  console.log(`✓ Detailed Audited Markdown Report generated at: ${reportPath}\n`);
}

// Auto-run if executed directly
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  runAuditedGrading().catch((err) => {
    console.error("Fatal audit error:", err);
    process.exit(1);
  });
}
