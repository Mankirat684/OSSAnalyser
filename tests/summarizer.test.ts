import * as path from "node:path";
import { runAnalyzerPipeline } from "../src/modules/analyzer/index.js";
import { GeminiSummarizerClient, summarizeCodebaseHierarchically } from "../src/modules/summarizer/index.js";

async function runSummarizerTest() {
  console.log("==================================================================");
  console.log("  TEST: Hierarchical Summarizer (Function -> File -> Dir -> Repo)");
  console.log("==================================================================\n");

  const repoRoot = path.resolve(process.cwd(), "test_repos/graphify-ts-test");
  const graphJsonPath = path.resolve(repoRoot, "graphify-out/graph.json");

  const analyzerResult = runAnalyzerPipeline({
    graphJsonPath,
    repoRootPath: repoRoot,
    filterCallablesOnly: true
  });

  const isLive = process.env.LIVE_GEMINI_TEST === "true";
  const gemini = new GeminiSummarizerClient({
    minIntervalMs: 2000,
    mockMode: !isLive
  });
  const result = await summarizeCodebaseHierarchically(analyzerResult, gemini, {
    repoName: "graphify-ts-test",
    repoRoot
  });

  console.log(`✓ Processed ${result.stats.totalFunctions} functions`);
  console.log(`✓ Processed ${result.stats.totalFiles} files`);
  console.log(`✓ Processed ${result.stats.totalDirectories} directories`);
  console.log(`✓ Repo Architecture: ${result.repo.architecture}`);
  console.log(`✓ Completed in ${(result.stats.durationMs / 1000).toFixed(2)}s`);
  console.log("\nALL SUMMARIZER TESTS PASSED! 🎉\n");
}

runSummarizerTest().catch((err) => {
  console.error("Summarizer test failed:", err);
  process.exit(1);
});
