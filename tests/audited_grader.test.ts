import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  validateAndNormalizeFactGrade,
  GoldFact,
  BenchmarkTask
} from "../bench/auditedGrader.js";

async function runAuditedGraderTests() {
  console.log("==========================================================");
  console.log("  TEST: Audited Grader & Rubric Guardrails");
  console.log("==========================================================");

  // 1. Verify Rubric Integrity
  const rubricPath = path.resolve(process.cwd(), "bench", "rubrics", "starlette_rubric.json");
  const rubric = JSON.parse(fs.readFileSync(rubricPath, "utf-8"));

  assert.strictEqual(rubric.version, "2.1.0", "Expected rubric version to be 2.1.0");
  assert.strictEqual(rubric.tasks.length, 6, "Expected 6 benchmark tasks in rubric");

  const totalFacts = rubric.tasks.reduce(
    (acc: number, t: BenchmarkTask) => acc + t.goldFacts.length,
    0
  );
  assert.strictEqual(totalFacts, 27, "Expected exactly 27 gold facts across all 6 tasks");
  console.log(`✓ Rubric verified: version ${rubric.version}, 6 tasks, 27 gold facts.`);

  const q2Task = rubric.tasks.find((t: BenchmarkTask) => t.id === "q2_asgi_dispatch");
  const q3Task = rubric.tasks.find((t: BenchmarkTask) => t.id === "q3_exceptions");
  assert.ok(q2Task, "q2_asgi_dispatch task must exist");
  assert.ok(q3Task, "q3_exceptions task must exist");

  const q2_fact_4 = q2Task.goldFacts.find((f: GoldFact) => f.id === "q2_fact_4")!;
  const q3_fact_3 = q3Task.goldFacts.find((f: GoldFact) => f.id === "q3_fact_3")!;
  assert.ok(q2_fact_4, "q2_fact_4 must exist");
  assert.ok(q3_fact_3, "q3_fact_3 must exist");

  // Load historical raw results for authentic answer text
  const resultsPath = path.resolve(process.cwd(), "bench", "results", "crosstool_results.json");
  const historicalResults = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));

  const graphifyQ3Answer = historicalResults.graphify.find(
    (r: any) => r.taskId === "q3_exceptions"
  )!.finalAnswer;

  const graphifyQ2Answer = historicalResults.graphify.find(
    (r: any) => r.taskId === "q2_asgi_dispatch"
  )!.finalAnswer;

  // --------------------------------------------------------------------------
  // Test Case 1: Graphify historical q3_fact_3 answer MUST NOT receive COVERED
  // --------------------------------------------------------------------------
  console.log("\n[Test 1] Verifying Graphify historical q3_fact_3 answer...");
  // Simulate the historical judge failure: judge mistakenly awarded COVERED
  const mockErroneousJudgeQ3 = {
    verdict: "COVERED",
    score: 1.0,
    citation: "If no matching handler is found, the exception is re-raised (raise exc) to bubble up to the ASGI server (e.g., Uvicorn).",
    justification: "The agent explains that exceptions are re-raised if no handler is found."
  };

  const grade1 = validateAndNormalizeFactGrade(q3_fact_3, graphifyQ3Answer, mockErroneousJudgeQ3);
  console.log(`  Grade result: verdict=${grade1.verdict}, score=${grade1.score}`);
  assert.strictEqual(
    grade1.verdict,
    "NOT_COVERED",
    "Graphify historical Q3 answer must be graded NOT_COVERED because it omits ServerErrorMiddleware"
  );
  assert.strictEqual(grade1.score, 0.0, "Score must be 0.0 for omitted ServerErrorMiddleware");
  assert.ok(
    grade1.justification?.includes("Omission of ServerErrorMiddleware"),
    "Justification must explain omission of ServerErrorMiddleware"
  );
  console.log("✓ Test 1 passed: Graphify Q3 answer correctly denied full credit.");

  // --------------------------------------------------------------------------
  // Test Case 2: Answer omitting reverse middleware ordering on q2_fact_4 MUST NOT receive COVERED
  // --------------------------------------------------------------------------
  console.log("\n[Test 2] Verifying answer omitting reverse order on q2_fact_4...");
  // Graphify's Q2 answer explains build_middleware_stack and onion layers, but omits reverse order
  const mockErroneousJudgeQ2 = {
    verdict: "COVERED",
    score: 1.0,
    citation: "When Starlette is initialized with a middleware parameter (or via add_middleware), build_middleware_stack() constructs this chain.",
    justification: "The agent explains that build_middleware_stack constructs the chain."
  };

  const grade2 = validateAndNormalizeFactGrade(q2_fact_4, graphifyQ2Answer, mockErroneousJudgeQ2);
  console.log(`  Grade result: verdict=${grade2.verdict}, score=${grade2.score}`);
  assert.strictEqual(
    grade2.verdict,
    "PARTIAL",
    "Answer omitting reverse middleware ordering must be capped at PARTIAL"
  );
  assert.strictEqual(grade2.score, 0.5, "Score must be capped at 0.5");
  assert.ok(
    grade2.justification?.includes("reverse execution order"),
    "Justification must note the omission of reverse execution order"
  );
  console.log("✓ Test 2 passed: Answer omitting reverse order correctly capped at PARTIAL (0.5).");

  // --------------------------------------------------------------------------
  // Test Case 3: Complete answer for q3_fact_3 CAN receive full credit
  // --------------------------------------------------------------------------
  console.log("\n[Test 3] Verifying complete answer for q3_fact_3...");
  const completeQ3Answer = `
In Starlette, unhandled exceptions that escape application routing and user exception handlers are caught by ServerErrorMiddleware (starlette/middleware/errors.py).
ServerErrorMiddleware serves as the outermost safety net wrapping the entire ASGI application stack.
When an uncaught exception occurs during request execution, ServerErrorMiddleware catches it and generates an HTTP 500 Internal Server Error response (or formats an HTML debug traceback if debug=True).
`;

  const validJudgeQ3 = {
    verdict: "COVERED",
    score: 1.0,
    citation: "When an uncaught exception occurs during request execution, ServerErrorMiddleware catches it and generates an HTTP 500 Internal Server Error response (or formats an HTML debug traceback if debug=True).",
    justification: "The agent accurately explains that ServerErrorMiddleware is the outermost safety net returning 500 responses."
  };

  const grade3 = validateAndNormalizeFactGrade(q3_fact_3, completeQ3Answer, validJudgeQ3);
  console.log(`  Grade result: verdict=${grade3.verdict}, score=${grade3.score}`);
  assert.strictEqual(grade3.verdict, "COVERED", "Complete answer must receive COVERED");
  assert.strictEqual(grade3.score, 1.0, "Complete answer must receive score 1.0");
  console.log("✓ Test 3 passed: Complete answer for q3_fact_3 awarded COVERED (1.0).");

  // --------------------------------------------------------------------------
  // Test Case 4: Complete answer for q2_fact_4 CAN receive full credit
  // --------------------------------------------------------------------------
  console.log("\n[Test 4] Verifying complete answer for q2_fact_4...");
  const completeQ2Answer = `
Starlette lazily compiles its entire middleware pipeline via build_middleware_stack() during startup or first request.
The method build_middleware_stack() constructs a nested onion-skin execution stack of ASGI callables wrapping around the core Router instance.
Importantly, user-configured middlewares are wrapped in reverse order (via reversed(self.user_middleware)), so that the first middleware added by the user forms the outermost layer of user processing.
`;

  const validJudgeQ2 = {
    verdict: "COVERED",
    score: 1.0,
    citation: "Importantly, user-configured middlewares are wrapped in reverse order (via reversed(self.user_middleware)), so that the first middleware added by the user forms the outermost layer of user processing.",
    justification: "The agent fully explains build_middleware_stack wrapping the Router and user middleware in reversed order."
  };

  const grade4 = validateAndNormalizeFactGrade(q2_fact_4, completeQ2Answer, validJudgeQ2);
  console.log(`  Grade result: verdict=${grade4.verdict}, score=${grade4.score}`);
  assert.strictEqual(grade4.verdict, "COVERED", "Complete answer must receive COVERED");
  assert.strictEqual(grade4.score, 1.0, "Complete answer must receive score 1.0");
  console.log("✓ Test 4 passed: Complete answer for q2_fact_4 awarded COVERED (1.0).");

  // --------------------------------------------------------------------------
  // Test Case 5: Missing or null citation must return NOT_COVERED
  // --------------------------------------------------------------------------
  console.log("\n[Test 5] Verifying null/empty citation handling...");
  const grade5 = validateAndNormalizeFactGrade(q3_fact_3, completeQ3Answer, {
    verdict: "COVERED",
    score: 1.0,
    citation: null,
    justification: "No citation provided"
  });
  assert.strictEqual(grade5.verdict, "NOT_COVERED");
  assert.strictEqual(grade5.score, 0.0);
  console.log("✓ Test 5 passed: Null citation strictly forces NOT_COVERED.");

  console.log("\nALL AUDITED GRADER & RUBRIC TESTS PASSED! 🎉\n");
}

runAuditedGraderTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
