import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert";
import { SQLiteStore } from "../src/storage/sqlite/sqliteStore.js";
import { CostEstimator } from "../src/summarizer/estimate.js";
import { SecretScanner } from "../src/summarizer/secretScanner.js";
import { runSummarizationPipeline } from "../src/summarizer/pipeline.js";
import { runIndexingPipeline } from "../src/pipeline/indexPipeline.js";
import type { LlmProvider, CompletionRequest, CompletionResponse } from "../src/summarizer/provider.js";

async function runPhase3Tests() {
  console.log("==========================================================");
  console.log("  TEST: Summarizer, Freshness Invalidation & Secret Scanner");
  console.log("==========================================================");

  // 1. Secret Scanner Tests
  console.log("\n[Test 1] Secret Scanner Redaction...");
  const rawSnippet = `
    const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
    const secret_token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature";
    const authHeader = "Bearer secret_bearer_token_1234567890";
    function connect() {
      // connecting with credentials
    }
  `;

  const scanResult = SecretScanner.scanAndRedact(rawSnippet);
  console.log("Redacted count:", scanResult.redactedCount);
  assert.ok(scanResult.redactedCount >= 4, "Should catch all 4 secret patterns");
  assert.ok(!scanResult.text.includes("AKIAIOSFODNN7EXAMPLE"), "AWS key must be redacted");
  assert.ok(!scanResult.text.includes("ghp_1234567890abcdefghijklmnopqrstuvwxyz"), "Token must be redacted");
  assert.ok(!scanResult.text.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "JWT must be redacted");
  assert.ok(scanResult.text.includes("[REDACTED]"), "Must include [REDACTED]");
  console.log("✓ Secret Scanner successfully redacted credentials, keys, and tokens");

  // Setup sandbox fixture repo in tmp/phase3_fixture
  const fixtureDir = path.join(process.cwd(), "tmp", "phase3_fixture");
  if (fs.existsSync(fixtureDir)) fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fileA = path.join(fixtureDir, "leaf.ts");
  const fileB = path.join(fixtureDir, "caller.ts");

  fs.writeFileSync(fileA, `export function calculateTax(amt: number): number {\n  return amt * 0.15;\n}\n`);
  fs.writeFileSync(fileB, `import { calculateTax } from "./leaf";\nexport function checkout(total: number): number {\n  return total + calculateTax(total);\n}\n`);

  const dbPath = path.join(fixtureDir, ".oss-analyser", "knowledge.db");
  const store = new SQLiteStore(dbPath);
  await store.init();
  const repoId = "repo_phase3_fixture";

  await runIndexingPipeline(store, { repoRoot: fixtureDir, noBlame: true });

  // 2. Pre-flight Estimate (offline with no LLM calls)
  console.log("\n[Test 2] Pre-flight Cost Estimation without calling LLM...");
  const estimate = await CostEstimator.calculate(store, repoId, "gemini");
  assert.strictEqual(estimate.totalSymbols, 2);
  assert.strictEqual(estimate.missingSymbols, 2);
  assert.ok(estimate.estimatedTokensIn > 0);
  console.log(`✓ Estimate verified: ${estimate.totalSymbols} symbols, ${estimate.estimatedTokensIn} est tokens`);

  // 3. Summarization with Counting Provider
  console.log("\n[Test 3] Bottom-Up Summarization with Counting Mock Provider...");
  let callCount = 0;
  const countingProvider: LlmProvider = {
    name: "counting-mock",
    models: ["mock-v1"],
    complete: async (req: CompletionRequest): Promise<CompletionResponse> => {
      callCount++;
      return {
        text: JSON.stringify([
          { nodeId: "any", summary: "Calculates tax based on rate." }
        ]),
        tokensIn: 100,
        tokensOut: 20
      };
    }
  };

  const stats1 = await runSummarizationPipeline(store, {
    repoId,
    repoRoot: fixtureDir,
    provider: countingProvider
  });

  assert.strictEqual(stats1.functionsSummarized, 2);
  assert.ok(callCount > 0, "Provider should have been called");
  const firstRunCalls = callCount;
  console.log(`✓ First run summarized ${stats1.functionsSummarized} functions in ${firstRunCalls} LLM calls`);

  // 4. Zero-token Resume Test
  console.log("\n[Test 4] Resumption & Checkpointing (Zero-token resume)...");
  callCount = 0;
  const stats2 = await runSummarizationPipeline(store, {
    repoId,
    repoRoot: fixtureDir,
    provider: countingProvider
  });

  assert.strictEqual(stats2.functionsSummarized, 0, "No functions should be re-summarized");
  assert.strictEqual(callCount, 0, "Zero LLM calls should be made on clean resume");
  console.log("✓ Zero-token resume verified: 0 LLM calls made on unchanged summaries");

  // 5. Invalidation on leaf edit: only leaf is stale, caller is possibly_stale
  console.log("\n[Test 5] Leaf modification staleness propagation...");
  fs.writeFileSync(fileA, `export function calculateTax(amt: number): number {\n  return amt * 0.20; // edited tax rate\n}\n`);
  await runIndexingPipeline(store, { repoRoot: fixtureDir, noBlame: true });

  const leafNode = await store.getNode("calculateTax");
  const callerNode = await store.getNode("checkout");

  assert.strictEqual(leafNode?.summaryStatus, "stale", "Leaf must be marked 'stale'");
  assert.strictEqual(callerNode?.summaryStatus, "possibly_stale", "Direct caller must be marked 'possibly_stale'");
  console.log("✓ Correctly flagged: leaf is 'stale' and caller is 'possibly_stale'");

  // 6. Summarize re-runs only stale by default
  console.log("\n[Test 6] Re-summarizing regenerates ONLY stale symbols by default...");
  callCount = 0;
  const stats3 = await runSummarizationPipeline(store, {
    repoId,
    repoRoot: fixtureDir,
    provider: countingProvider,
    includePossiblyStale: false
  });

  assert.strictEqual(stats3.functionsSummarized, 1, "Only the 1 stale symbol (calculateTax) should be summarized");
  console.log("✓ Selective re-summarization verified: exactly 1 stale symbol summarized");

  // 7. Heuristic Provider Fallback Test
  console.log("\n[Test 7] Forced Provider Failure Fallback...");
  const failingProvider: LlmProvider = {
    name: "failing-provider",
    models: ["error-v1"],
    complete: async () => {
      throw new Error("HTTP 503 Provider unavailable");
    }
  };

  // Mark leaf stale again
  await store.updateSummaryStatus(leafNode!.id, "stale");
  const stats4 = await runSummarizationPipeline(store, {
    repoId,
    repoRoot: fixtureDir,
    provider: failingProvider
  });

  const leafFallback = await store.getNode("calculateTax");
  assert.strictEqual(leafFallback?.summaryStatus, "heuristic", "Fallback must set summary_status = 'heuristic'");
  assert.ok(leafFallback?.summary?.includes("calculateTax"), "Heuristic summary should mention function name");
  console.log("✓ Provider failure handled gracefully: degraded to heuristic summary without crashing");

  await store.close();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  console.log("\nALL PHASE 3 SUMMARIZER & FRESHNESS TESTS PASSED! 🎉\n");
}

runPhase3Tests();
