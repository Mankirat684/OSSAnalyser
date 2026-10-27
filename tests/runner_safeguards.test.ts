import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  verifyFreezeIntegrity,
  createSafeRunDirectory,
  generateSessionId,
  judgeSessionAnswer,
  runFullBenchmark,
  runAgentSession,
  computeStats,
  ArmRunResult,
  BenchmarkTask
} from "../bench/crosstoolRunner.js";

async function runRunnerSafeguardTests() {
  console.log("==========================================================");
  console.log("  TEST: Benchmark Runner Safety, Repetitions & Freeze");
  console.log("==========================================================");

  // --------------------------------------------------------------------------
  // Test 1: Exactly 54 Expected Sessions & Unique Session IDs
  // --------------------------------------------------------------------------
  console.log("\n[Test 1] Verifying 54 sessions & deterministic session ID generation...");
  const rubricPath = path.resolve(process.cwd(), "bench", "rubrics", "starlette_rubric.json");
  const rubric = JSON.parse(fs.readFileSync(rubricPath, "utf-8"));
  const tasks: BenchmarkTask[] = rubric.tasks;
  const arms = ["baseline", "graphify", "oss_analyser"] as const;
  const repetitions = 3;

  assert.strictEqual(tasks.length, 6, "Expected exactly 6 rubric tasks");
  assert.strictEqual(arms.length, 3, "Expected exactly 3 arms");

  const sessionIds: string[] = [];
  for (let rep = 1; rep <= repetitions; rep++) {
    for (const task of tasks) {
      for (const arm of arms) {
        const id = generateSessionId(rep, task.id, arm);
        sessionIds.push(id);
      }
    }
  }

  assert.strictEqual(sessionIds.length, 54, `Expected exactly 54 sessions, got ${sessionIds.length}`);
  const uniqueSessionIds = new Set(sessionIds);
  assert.strictEqual(uniqueSessionIds.size, 54, "All 54 session IDs must be unique");

  assert.strictEqual(sessionIds[0], "rep1_q1_authentication_baseline");
  assert.strictEqual(sessionIds[53], "rep3_q6_blast_radius_oss_analyser");
  console.log(`✓ Test 1 passed: Exactly 54 unique session IDs generated deterministically.`);

  // --------------------------------------------------------------------------
  // Test 2: Safe Run Directory Creation & No Overwrite Guarantee
  // --------------------------------------------------------------------------
  console.log("\n[Test 2] Verifying safe run directory creation and overwrite prevention...");
  const testBaseDir = path.resolve(process.cwd(), "bench", "results", "test_runs_scratch");
  fs.mkdirSync(testBaseDir, { recursive: true });

  const testTs = "20990101_120000";
  const runDir1 = createSafeRunDirectory(testBaseDir, testTs);
  assert.ok(fs.existsSync(runDir1), "Run directory must be created on disk");

  // Attempting to create the exact same run directory MUST throw
  assert.throws(
    () => createSafeRunDirectory(testBaseDir, testTs),
    /already exists/,
    "Creating an existing directory must throw to prevent overwrite"
  );

  // Clean up test directory
  fs.rmSync(testBaseDir, { recursive: true, force: true });
  console.log("✓ Test 2 passed: Safe run directory enforces zero-overwrite guarantee.");

  // --------------------------------------------------------------------------
  // Test 3: Fail-Fast Freeze Hash Integrity Verification
  // --------------------------------------------------------------------------
  console.log("\n[Test 3] Verifying fail-fast freeze hash integrity checks...");
  // 3a: Valid freeze check passes
  const validFreeze = verifyFreezeIntegrity();
  assert.strictEqual(validFreeze.rubricVersion, "2.1.0");
  assert.strictEqual(validFreeze.tasksCount, 6);
  assert.strictEqual(validFreeze.goldFactsCount, 27);
  console.log("  ✓ Valid freeze manifest verified successfully.");

  // 3b: Missing freeze manifest throws
  assert.throws(
    () => verifyFreezeIntegrity(path.resolve(process.cwd(), "bench", "non_existent_freeze.json")),
    /Freeze manifest not found/,
    "Missing freeze manifest must abort immediately"
  );

  // 3c: Tampered rubric hash throws
  const fakeManifestDir = path.resolve(process.cwd(), "bench", "results", "fake_manifest_scratch");
  fs.mkdirSync(fakeManifestDir, { recursive: true });
  const fakeManifestPath = path.join(fakeManifestDir, "tampered_rubric_manifest.json");

  fs.writeFileSync(
    fakeManifestPath,
    JSON.stringify({
      ...validFreeze,
      rubricSha256: "0000000000000000000000000000000000000000000000000000000000000000"
    }),
    "utf-8"
  );

  assert.throws(
    () => verifyFreezeIntegrity(fakeManifestPath),
    /Rubric SHA-256 mismatch/,
    "Tampered rubric hash must trigger fail-fast abort"
  );

  // 3d: Tampered grader hash throws
  const fakeGraderManifestPath = path.join(fakeManifestDir, "tampered_grader_manifest.json");
  fs.writeFileSync(
    fakeGraderManifestPath,
    JSON.stringify({
      ...validFreeze,
      auditedGraderSha256: "1111111111111111111111111111111111111111111111111111111111111111"
    }),
    "utf-8"
  );

  assert.throws(
    () => verifyFreezeIntegrity(fakeGraderManifestPath),
    /Audited grader SHA-256 mismatch/,
    "Tampered grader hash must trigger fail-fast abort"
  );

  fs.rmSync(fakeManifestDir, { recursive: true, force: true });
  console.log("✓ Test 3 passed: Fail-fast verification halts on missing or mismatched hashes.");

  // --------------------------------------------------------------------------
  // Test 4: Audited Grader Session Judge Integration & Metric Separation
  // --------------------------------------------------------------------------
  console.log("\n[Test 4] Verifying audited judge session integration...");
  const mockTask: BenchmarkTask = tasks[0]; // q1_authentication
  const mockAnswer = `
AuthenticationBackend is an abstract class defining async def authenticate(self, conn: HTTPConnection) -> tuple[AuthCredentials, BaseUser] | None.
AuthenticationMiddleware intercepts both http and websocket connection scopes, setting scope["auth"] and scope["user"].
If auth_result is None, default unauthenticated objects are assigned: scope["auth"], scope["user"] = AuthCredentials(), UnauthenticatedUser().
The @requires decorator checks scopes with has_required_scope; if unpermitted, it raises HTTPException 403 or closes WebSockets.
The default authentication error handler returns a PlainTextResponse with status 400.
`;

  // Simulated judge caller returning valid parsed items
  const mockJudgeCaller = async (reqBody: any) => {
    return {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify(
                  mockTask.goldFacts.map((gf) => ({
                    factId: gf.id,
                    verdict: "COVERED",
                    score: 1.0,
                    citation: mockAnswer.split("\n")[1].trim(),
                    justification: "Verified complete coverage against Starlette code."
                  }))
                )
              }
            ]
          }
        }
      ]
    };
  };

  const judgeResult = await judgeSessionAnswer(mockTask, mockAnswer, mockJudgeCaller);
  assert.strictEqual(judgeResult.coverage, 100);
  assert.strictEqual(judgeResult.grades.length, 5);
  assert.ok(judgeResult.durationMs >= 0, "Evaluator timing must be recorded");
  assert.ok(judgeResult.prompt.length > 50, "Judge prompt must be preserved");
  console.log(`✓ Test 4 passed: Audited grader integration functions properly with separated timing.`);

  // --------------------------------------------------------------------------
  // Test 5: Simulated Partial-Run Persistence on Failure
  // --------------------------------------------------------------------------
  console.log("\n[Test 5] Verifying partial-run persistence on interruption...");
  const simRunDir = path.resolve(process.cwd(), "bench", "results", "simulated_run_scratch");
  if (fs.existsSync(simRunDir)) fs.rmSync(simRunDir, { recursive: true, force: true });

  const mockAgentCaller = async () => ({
    candidates: [{ content: { parts: [{ text: "Mock complete answer text for test." }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 }
  });

  // Mock caller that throws on Repetition 2 Arm 2
  let callCount = 0;
  const failingAgentCaller = async () => {
    callCount++;
    if (callCount > 3) {
      throw new Error("Simulated network drop / API quota cutoff on Repetition 2");
    }
    return mockAgentCaller();
  };

  try {
    await runFullBenchmark({
      runDir: simRunDir,
      repetitions: 2,
      tasks: [tasks[0]], // 1 task * 3 arms * 2 reps = 6 expected
      skipAdapterInit: true,
      interArmPacingMs: 0,
      toolPacingMs: 0,
      agentCaller: failingAgentCaller,
      judgeCaller: mockJudgeCaller
    });
    assert.fail("Runner should have thrown on simulated failure");
  } catch (err: any) {
    if (err.message.includes("Runner should have thrown")) {
      throw err;
    }
    assert.ok(err.message.includes("Simulated network drop"));
  }

  // Verify Repetition 1 was saved immediately before the failure occurred
  const rep1RawPath = path.join(simRunDir, "rep1_raw_results.json");
  const rep1AuditedPath = path.join(simRunDir, "rep1_audited_results.json");
  const failurePath = path.join(simRunDir, "partial_failure.json");

  assert.ok(fs.existsSync(rep1RawPath), "Repetition 1 raw results must be preserved");
  assert.ok(fs.existsSync(rep1AuditedPath), "Repetition 1 audited results must be preserved");
  assert.ok(fs.existsSync(failurePath), "partial_failure.json must record the exact failure point");

  const rep1Raw = JSON.parse(fs.readFileSync(rep1RawPath, "utf-8"));
  assert.strictEqual(rep1Raw.length, 3, "Repetition 1 should contain all 3 completed arm sessions");

  const failureData = JSON.parse(fs.readFileSync(failurePath, "utf-8"));
  assert.strictEqual(failureData.completedSessionsCount, 3);
  assert.ok(failureData.errorMessage.includes("Simulated network drop"));

  // Clean up scratch dir
  fs.rmSync(simRunDir, { recursive: true, force: true });
  console.log("✓ Test 5 passed: Interrupted runs preserve completed repetitions and record failure point.");

  // --------------------------------------------------------------------------
  // Test 6: Missing, Partial, Genuine-Zero UsageMetadata & Token Isolation
  // --------------------------------------------------------------------------
  console.log("\n[Test 6] Verifying missing, partial, genuine-zero usageMetadata handling & token isolation...");

  const baseJudgeCaller = async () => ({
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify(
                mockTask.goldFacts.map((gf) => ({
                  factId: gf.id,
                  verdict: "NOT_COVERED",
                  score: 0.0,
                  citation: "",
                  justification: "Test run."
                }))
              )
            }
          ]
        }
      }
    ]
  });

  // 6a: Present usageMetadata
  const presentAgentCaller = async () => ({
    candidates: [{ content: { parts: [{ text: "Present tokens test answer." }] } }],
    usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 50 }
  });
  const resPresent = await runAgentSession(
    "baseline",
    mockTask,
    process.cwd(),
    "",
    {} as any,
    1,
    8,
    presentAgentCaller,
    baseJudgeCaller,
    0
  );
  assert.strictEqual(resPresent.promptTokens, 150, "Prompt tokens must match reported count");
  assert.strictEqual(resPresent.completionTokens, 50, "Completion tokens must match reported count");
  assert.strictEqual(resPresent.totalTokens, 200, "Total tokens must be sum of prompt and completion");
  assert.ok(resPresent.costUSD !== null && resPresent.costUSD > 0, "Cost must be calculated when tokens present");
  console.log("  ✓ 6a: Present usageMetadata correctly recorded.");

  // 6b: Missing/absent usageMetadata (must be null, not 0)
  const absentAgentCaller = async () => ({
    candidates: [{ content: { parts: [{ text: "Absent tokens test answer." }] } }],
    usageMetadata: undefined
  });
  const resAbsent = await runAgentSession(
    "baseline",
    mockTask,
    process.cwd(),
    "",
    {} as any,
    1,
    8,
    absentAgentCaller,
    baseJudgeCaller,
    0
  );
  assert.strictEqual(resAbsent.promptTokens, null, "Missing prompt tokens must be null, not 0");
  assert.strictEqual(resAbsent.completionTokens, null, "Missing completion tokens must be null, not 0");
  assert.strictEqual(resAbsent.totalTokens, null, "Missing total tokens must be null, not 0");
  assert.strictEqual(resAbsent.costUSD, null, "Missing cost must be null, not 0");
  console.log("  ✓ 6b: Missing usageMetadata explicitly set to null.");

  // 6c: Partial usageMetadata (prompt present, completion absent)
  const partialAgentCaller = async () => ({
    candidates: [{ content: { parts: [{ text: "Partial tokens test answer." }] } }],
    usageMetadata: { promptTokenCount: 100 }
  });
  const resPartial = await runAgentSession(
    "baseline",
    mockTask,
    process.cwd(),
    "",
    {} as any,
    1,
    8,
    partialAgentCaller,
    baseJudgeCaller,
    0
  );
  assert.strictEqual(resPartial.promptTokens, 100, "Present prompt token part must be preserved");
  assert.strictEqual(resPartial.completionTokens, null, "Absent completion token part must be null");
  assert.strictEqual(resPartial.totalTokens, 100, "Total tokens reflects available component");
  assert.strictEqual(resPartial.costUSD, null, "Cost cannot be computed without completion tokens");
  console.log("  ✓ 6c: Partial usageMetadata correctly handled.");

  // 6d: Genuine reported zero (must be 0, not null)
  const zeroAgentCaller = async () => ({
    candidates: [{ content: { parts: [{ text: "Zero tokens test answer." }] } }],
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 }
  });
  const resZero = await runAgentSession(
    "baseline",
    mockTask,
    process.cwd(),
    "",
    {} as any,
    1,
    8,
    zeroAgentCaller,
    baseJudgeCaller,
    0
  );
  assert.strictEqual(resZero.promptTokens, 0, "Genuine 0 prompt tokens must remain 0");
  assert.strictEqual(resZero.completionTokens, 0, "Genuine 0 completion tokens must remain 0");
  assert.strictEqual(resZero.totalTokens, 0, "Genuine 0 total tokens must remain 0");
  assert.strictEqual(resZero.costUSD, 0, "Genuine 0 cost must remain 0");
  console.log("  ✓ 6d: Genuine zero tokens preserved as 0.");

  // 6e: Evaluator token usage isolation
  const judgeCallerWithTokens = async () => ({
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify(
                mockTask.goldFacts.map((gf) => ({
                  factId: gf.id,
                  verdict: "NOT_COVERED",
                  score: 0.0,
                  citation: "",
                  justification: "Test judge."
                }))
              )
            }
          ]
        }
      }
    ],
    usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 150 }
  });
  const resSeparation = await runAgentSession(
    "baseline",
    mockTask,
    process.cwd(),
    "",
    {} as any,
    1,
    8,
    presentAgentCaller, // reports 150 prompt, 50 completion
    judgeCallerWithTokens, // reports 400 prompt, 150 completion
    0
  );
  assert.strictEqual(resSeparation.promptTokens, 150, "Agent prompt tokens must not mix with judge tokens");
  assert.strictEqual(resSeparation.completionTokens, 50, "Agent completion tokens must not mix with judge tokens");
  assert.strictEqual(resSeparation.evaluatorPromptTokens, 400, "Evaluator prompt tokens recorded separately");
  assert.strictEqual(resSeparation.evaluatorCompletionTokens, 150, "Evaluator completion tokens recorded separately");
  assert.strictEqual(resSeparation.evaluatorTotalTokens, 550, "Evaluator total tokens recorded separately");
  console.log("  ✓ 6e: Agent and evaluator tokens strictly separated.");

  // 6f: Aggregation computeStats handles missing, partial, and zero tokens
  const mockRuns: ArmRunResult[] = [
    { ...resPresent, totalTokens: 200, costUSD: 0.00002 },
    { ...resAbsent, totalTokens: null, costUSD: null },
    { ...resZero, totalTokens: 0, costUSD: 0 }
  ];
  const mixedStats = computeStats(mockRuns);
  // Valid tokens: [200, 0] -> mean = 100, median = 100
  assert.strictEqual(mixedStats.meanTokens, 100, "Mean tokens must exclude null session and include genuine 0");
  assert.strictEqual(mixedStats.medianTokens, 100, "Median tokens must exclude null session");
  assert.strictEqual(mixedStats.unavailableTokenSessions, 1, "Must report 1 unavailable token session");
  // Valid costs: [0.00002, 0] -> sum = 0.00002
  assert.strictEqual(mixedStats.totalCost, 0.00002, "Total cost must exclude null cost session");
  assert.strictEqual(mixedStats.unavailableCostSessions, 1, "Must report 1 unavailable cost session");

  // All null sessions
  const allNullRuns: ArmRunResult[] = [
    { ...resAbsent, totalTokens: null, costUSD: null },
    { ...resAbsent, totalTokens: null, costUSD: null }
  ];
  const allNullStats = computeStats(allNullRuns);
  assert.strictEqual(allNullStats.meanTokens, null, "Mean tokens must be null if all sessions unavailable");
  assert.strictEqual(allNullStats.medianTokens, null, "Median tokens must be null if all sessions unavailable");
  assert.strictEqual(allNullStats.unavailableTokenSessions, 2, "Must report all sessions as unavailable");
  assert.strictEqual(allNullStats.totalCost, null, "Total cost must be null if all sessions unavailable");
  assert.strictEqual(allNullStats.unavailableCostSessions, 2, "Must report all cost sessions as unavailable");
  console.log("  ✓ 6f: Aggregate computeStats accurately excludes nulls and tracks unavailable counts.");

  console.log("✓ Test 6 passed: Missing, partial, genuine-zero usageMetadata and evaluator separation fully verified.");

  // --------------------------------------------------------------------------
  // Test 7: Resume Existing Run & Skip Completed Repetitions
  // --------------------------------------------------------------------------
  console.log("\n[Test 7] Verifying run resume & completed repetition skip...");
  const resumeScratchDir = path.resolve(process.cwd(), "bench", "results", "resume_test_scratch");
  if (fs.existsSync(resumeScratchDir)) fs.rmSync(resumeScratchDir, { recursive: true, force: true });
  fs.mkdirSync(resumeScratchDir, { recursive: true });

  // Seed Repetition 1 on disk as already completed (3 sessions for 1 task * 3 arms)
  const seededRep1Runs: ArmRunResult[] = [
    { ...resPresent, sessionId: "rep1_q1_authentication_baseline", arm: "baseline", repetition: 1, taskId: tasks[0].id },
    { ...resPresent, sessionId: "rep1_q1_authentication_graphify", arm: "graphify", repetition: 1, taskId: tasks[0].id },
    { ...resPresent, sessionId: "rep1_q1_authentication_oss_analyser", arm: "oss_analyser", repetition: 1, taskId: tasks[0].id }
  ];
  fs.writeFileSync(path.join(resumeScratchDir, "rep1_raw_results.json"), JSON.stringify(seededRep1Runs, null, 2), "utf-8");
  fs.writeFileSync(path.join(resumeScratchDir, "rep1_audited_results.json"), JSON.stringify(seededRep1Runs, null, 2), "utf-8");

  // Track agent calls during the resumed run
  let rep2AgentCalls = 0;
  const countingAgentCaller = async () => {
    rep2AgentCalls++;
    return {
      candidates: [{ content: { parts: [{ text: "Repetition 2 answer." }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40 }
    };
  };

  await runFullBenchmark({
    runDir: resumeScratchDir,
    repetitions: 2,
    tasks: [tasks[0]], // 1 task * 3 arms = 3 sessions per rep
    skipAdapterInit: true,
    interArmPacingMs: 0,
    toolPacingMs: 0,
    agentCaller: countingAgentCaller,
    judgeCaller: mockJudgeCaller
  });

  // Since Rep 1 was already on disk, agentCaller should have only been invoked for Rep 2 (3 calls)!
  assert.strictEqual(rep2AgentCalls, 3, "Agent caller must only be called for Repetition 2, not Repetition 1");

  // Check that final aggregated results contain all 6 sessions (3 from Rep 1 + 3 from Rep 2)
  const aggPath = path.join(resumeScratchDir, "aggregated_audited_results.json");
  assert.ok(fs.existsSync(aggPath), "Aggregated results must be written");
  const aggData = JSON.parse(fs.readFileSync(aggPath, "utf-8"));
  assert.strictEqual(aggData.allSessions.length, 6, "Aggregated dataset must contain both Rep 1 and Rep 2 sessions");
  assert.strictEqual(aggData.allSessions[0].sessionId, "rep1_q1_authentication_baseline");
  assert.strictEqual(aggData.allSessions[3].sessionId, "rep2_q1_authentication_baseline");

  fs.rmSync(resumeScratchDir, { recursive: true, force: true });
  console.log("✓ Test 7 passed: Resumed runs successfully restore completed repetitions from disk.");

  console.log("\nALL RUNNER SAFEGUARD & INTEGRATION TESTS PASSED! 🎉\n");
}

runRunnerSafeguardTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
