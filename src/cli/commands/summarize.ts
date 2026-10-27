import * as path from "node:path";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { SQLiteStore } from "../../storage/sqlite/sqliteStore.js";
import { CostEstimator } from "../../summarizer/estimate.js";
import { runSummarizationPipeline } from "../../summarizer/pipeline.js";
import { GeminiProvider } from "../../summarizer/providers/gemini.js";
import { OllamaProvider } from "../../summarizer/providers/ollama.js";
import { HeuristicProvider } from "../../summarizer/providers/heuristic.js";
import type { LlmProvider } from "../../summarizer/provider.js";
import { VectorEngine } from "../../retrieval/vectorStore.js";
import { getDefaultEmbeddingProvider } from "../../retrieval/embeddingProvider.js";

export interface SummarizeCommandOptions {
  repo?: string;
  estimate?: boolean;
  yes?: boolean;
  provider?: string;
  model?: string;
  apiKey?: string;
  includePossiblyStale?: boolean;
  getBatch?: boolean;
  saveBatch?: string;
  reset?: boolean;
  resetScope?: "all" | "possibly_stale" | "heuristic";
  json?: boolean;
}

function promptConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const clean = answer.trim().toLowerCase();
      resolve(clean === "y" || clean === "yes" || clean === "");
    });
  });
}

export async function runSummarizeCommand(options: SummarizeCommandOptions): Promise<void> {
  const repoRoot = path.resolve(options.repo || process.cwd());
  const dbPath = path.join(repoRoot, ".oss-analyser", "knowledge.db");

  if (!fs.existsSync(dbPath)) {
    console.error(`Knowledge database not found at ${dbPath}. Run 'oss-analyser init' and 'oss-analyser index' first.`);
    process.exit(1);
  }

  const repoName = path.basename(repoRoot);
  const repoId = `repo_${repoName.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  const store = new SQLiteStore(dbPath);
  await store.init();

  const providerName = (options.provider || "gemini").toLowerCase();
  const modelName = options.model || (providerName === "gemini" ? "gemini-3.5-flash-lite" : "qwen2.5-coder");

  // Handle reset for re-summarization
  if (options.reset) {
    const { resetRepoSummaries } = await import("../../summarizer/agentSummarizer.js");
    const result = await resetRepoSummaries(store, repoId, {
      scope: options.resetScope || "all"
    });
    console.log(result.message);
    await store.close();
    return;
  }

  // Handle batch export for harness/agent
  if (options.getBatch) {
    const { getNextAgentBatch } = await import("../../summarizer/agentSummarizer.js");
    const batch = await getNextAgentBatch(store, repoId, repoRoot);
    if (options.json) {
      console.log(JSON.stringify(batch, null, 2));
    } else {
      console.log(batch.prompt || batch.message || "No batch remaining.");
    }
    await store.close();
    return;
  }

  // Handle batch save from harness/agent
  if (options.saveBatch) {
    const raw = fs.readFileSync(path.resolve(options.saveBatch), "utf-8");
    const parsed = JSON.parse(raw);
    const summaries = Array.isArray(parsed) ? parsed : parsed.summaries || [];
    const { saveAgentBatch } = await import("../../summarizer/agentSummarizer.js");
    const result = await saveAgentBatch(store, repoId, repoRoot, summaries);
    console.log(JSON.stringify(result, null, 2));
    await store.close();
    return;
  }

  // Handle harness provider explanation
  if (providerName === "harness") {
    console.log(`\n==========================================================`);
    console.log(`  Harness-Driven Summarization Mode (Agent-Driven)`);
    console.log(`==========================================================`);
    console.log(`In harness mode, your AI coding assistant (Antigravity/Claude Code/Cursor)`);
    console.log(`uses its own active model session to generate summaries without external API keys.`);
    console.log(`\nTo execute this in chat:`);
    console.log(`  1. Ask your agent: "Summarize the unsummarized functions in this codebase."`);
    console.log(`  2. The agent uses the MCP tools "get_summary_batch" and "save_summary_batch".`);
    console.log(`==========================================================\n`);
    await store.close();
    return;
  }

  // 1. Calculate Pre-Flight Estimate
  const estimate = await CostEstimator.calculate(store, repoId, providerName, options.includePossiblyStale);

  if (options.estimate) {
    if (options.json) {
      console.log(JSON.stringify(estimate, null, 2));
    } else {
      CostEstimator.printEstimate(estimate, providerName, modelName);
    }
    await store.close();
    return;
  }

  // 2. Print estimate and prompt confirmation unless --yes is passed
  if (!options.yes && !options.json) {
    CostEstimator.printEstimate(estimate, providerName, modelName);
    const confirmed = await promptConfirmation("Proceed with hierarchical summarization? [Y/n]: ");
    if (!confirmed) {
      console.log("Summarization aborted by user.");
      await store.close();
      return;
    }
  }

  // 3. Initialize Provider
  let provider: LlmProvider;
  if (providerName === "ollama") {
    provider = new OllamaProvider(modelName);
  } else if (providerName === "heuristic") {
    provider = new HeuristicProvider();
  } else {
    // Gemini
    const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    const hasKey = !!apiKey;
    if (!hasKey) {
      console.error(`\n[Error] GEMINI_API_KEY is not set.`);
      console.error(`• Supply it directly via CLI flag:`);
      console.error(`  oss-analyser summarize --provider gemini --api-key AIzaSy... --yes`);
      console.error(`• Or set it in your .env or shell environment:`);
      console.error(`  $env:GEMINI_API_KEY="AIzaSy..."; oss-analyser summarize --provider gemini --yes`);
      console.error(`• To use your AI IDE's active model (e.g. Gemini 3.8 Flash High) with zero API keys:`);
      console.error(`  Run in chat via /summarize-codebase or ask your agent to summarize.`);
      console.error(`• To run structural heuristic simulation without an LLM:`);
      console.error(`  oss-analyser summarize --provider heuristic --yes\n`);
      await store.close();
      process.exit(1);
    }
    provider = new GeminiProvider(apiKey, modelName, false);
  }

  console.log(`\nStarting bottom-up hierarchical summarization...`);

  // 4. Run pipeline
  const stats = await runSummarizationPipeline(store, {
    repoId,
    repoRoot,
    provider,
    includePossiblyStale: options.includePossiblyStale,
    onProgress: (stage, curr, total) => {
      if (!options.json) {
        process.stdout.write(`\r  ↳ Summarizing ${stage}: [${curr}/${total}] levels/files...`);
      }
    }
  });

  // 5. Embed Summarized Nodes locally in 768 dimensions ($0, zero external keys)
  let embeddedCount = 0;
  try {
    if (!options.json) {
      process.stdout.write(`\n  ↳ Generating local 768-d neural embeddings with default model...`);
    }
    const vEngine = new VectorEngine();
    const eProvider = getDefaultEmbeddingProvider();
    embeddedCount = await vEngine.embedNodes(store, repoId, eProvider);
    if (!options.json) {
      console.log(`\r  ✓ Generated & stored ${embeddedCount} local 768-d vector embeddings in sqlite-vec.`);
    }
  } catch (err) {
    if (!options.json) {
      console.warn(`\n  ↳ Warning: vector embedding generation skipped or encountered fallback:`, err);
    }
  }

  await store.close();

  if (options.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log(`\n\n✓ Hierarchical Summarization Completed in ${(stats.durationMs / 1000).toFixed(2)}s`);
  console.log(`----------------------------------------------------------`);
  console.log(`  • Functions Summarized: ${stats.functionsSummarized}`);
  console.log(`  • Files Summarized    : ${stats.filesSummarized}`);
  console.log(`  • 768-d Vectors Stored: ${embeddedCount} (sqlite-vec)`);
  console.log(`  • Tokens In (Prompt)  : ~${stats.tokensIn.toLocaleString()}`);
  console.log(`  • Tokens Out          : ~${stats.tokensOut.toLocaleString()}`);
  console.log(`----------------------------------------------------------\n`);
}
