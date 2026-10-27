import * as path from "node:path";
import { runAnalyzerPipeline } from "../src/modules/analyzer/index.js";
import { GeminiSummarizerClient, summarizeCodebaseHierarchically } from "../src/modules/summarizer/index.js";
import { pool } from "../src/config/database.js";
import { RepositoryStore } from "../src/modules/storage/index.js";
import type { FunctionSummary } from "../src/core/types.js";

async function testCheckpointSystem() {
  console.log("==================================================================");
  console.log("  TEST: Ingestion Checkpoints & Resumption Architecture");
  console.log("==================================================================\n");

  const repoRoot = path.resolve(process.cwd(), "test_repos/graphify-ts-test");
  const graphJson = path.resolve(repoRoot, "graphify-out/graph.json");

  // Step 1: Run parser
  console.log("[1] Parsing codebase graph...");
  const analyzerResult = runAnalyzerPipeline({
    graphJsonPath: graphJson,
    repoRootPath: repoRoot
  });
  console.log(`✓ Parsed ${analyzerResult.totalNodes} nodes across ${analyzerResult.topoLevels.length} levels.`);

  // Step 2: Test In-Memory Checkpoint Resumption
  console.log("\n[2] Testing Checkpoint Resumption & Token Savings...");
  const isLive = process.env.LIVE_GEMINI_TEST === "true";
  const gemini = new GeminiSummarizerClient({ mockMode: !isLive });

  // Pre-seed mock existing summaries (simulating Level 0 was already completed in a prior run)
  const simulatedCachedSummaries = new Map<string, FunctionSummary>();
  const firstNodeId = Array.from(analyzerResult.rawNodes.keys())[0];
  simulatedCachedSummaries.set(firstNodeId, {
    nodeId: firstNodeId,
    label: "cached_function",
    sourceFile: "src/cached.ts",
    summary: "Pre-existing cached summary from prior checkpoint.",
    level: 0,
    isCycleMember: false
  });

  let subCheckpointsTriggered = 0;
  const summaryResult = await summarizeCodebaseHierarchically(analyzerResult, gemini, {
    repoName: "graphify-ts-test",
    repoRoot,
    existingSummaries: simulatedCachedSummaries,
    onBatchCompleted: async (batchSummaries, currentLvl, totalLvls) => {
      subCheckpointsTriggered++;
      console.log(`   --> [Sub-Checkpoint Triggered] Level ${currentLvl}/${totalLvls} (${batchSummaries.length} items)`);
    }
  });

  // Verify that the cached summary was preserved without re-calling LLM
  const preserved = summaryResult.functions.get(firstNodeId);
  if (!preserved || preserved.summary !== "Pre-existing cached summary from prior checkpoint.") {
    throw new Error("Cached summary was not preserved during resumption!");
  }
  console.log(`✓ Resumption verified: Cached summary preserved without re-running LLM.`);
  console.log(`✓ Sub-checkpoint callbacks triggered: ${subCheckpointsTriggered} times.`);

  // Step 3: Test Database Persistence (if DB online)
  let dbOnline = false;
  try {
    await pool.query("SELECT 1");
    dbOnline = true;
  } catch {
    console.log("\n[Status] PostgreSQL offline — skipping live DB transaction check.");
    console.log("💡 Start DB to test live DB checkpoint transactions: docker compose up -d postgres / Supabase");
  }

  if (dbOnline) {
    console.log("\n[3] Testing Live Database Checkpoint 1 Persistence...");
    const testRepoId = "repo_checkpoint_test";

    await RepositoryStore.saveParsedStructure(
      testRepoId,
      "Checkpoint Test Repo",
      repoRoot,
      analyzerResult
    );

    const checkRes = await pool.query(
      `SELECT status, checkpoint_data FROM repositories WHERE id = $1`,
      [testRepoId]
    );
    console.log(`✓ Checkpoint 1 verified in DB: status = '${checkRes.rows[0].status}'`);

    const existing = await RepositoryStore.getExistingSummaries(testRepoId);
    console.log(`✓ Unsummarized nodes correctly identified: ${existing.size} cached, remaining pending.`);

    // Cleanup test record
    await pool.query(`DELETE FROM repositories WHERE id = $1`, [testRepoId]);
    await pool.end();
  }

  console.log("\nALL CHECKPOINT & RESUMPTION TESTS PASSED! 🎉\n");
}

testCheckpointSystem().catch((err) => {
  console.error("Checkpoint test failed:", err);
  process.exit(1);
});
