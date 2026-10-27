import type { GraphStore, NodeRecord } from "../storage/graphStore.js";

export interface SummarizeEstimate {
  nodesByLevel: Record<number, number>;
  totalSymbols: number;
  totalFiles: number;
  staleSymbols: number;
  missingSymbols: number;
  estimatedTokensIn: number;
  estimatedTokensOut: number;
  estimatedCostUsd: number;
  estimatedDurationSec: number;
}

export class CostEstimator {
  public static async calculate(
    store: GraphStore,
    repoId: string,
    provider = "gemini",
    includePossiblyStale = false
  ): Promise<SummarizeEstimate> {
    const allNodes = await store.getAllNodes(repoId);
    const symbols = allNodes.filter((n) => n.nodeType === "function" || n.nodeType === "method" || n.nodeType === "class");
    const files = allNodes.filter((n) => n.nodeType === "file");

    const nodesByLevel: Record<number, number> = {};
    for (const s of symbols) {
      const lvl = s.level ?? 0;
      nodesByLevel[lvl] = (nodesByLevel[lvl] || 0) + 1;
    }

    const missingSymbols = symbols.filter((s) => s.summaryStatus === "missing" || s.summary === "pending_summary").length;
    const staleSymbols = symbols.filter((s) => s.summaryStatus === "stale").length;
    const possiblyStaleSymbols = symbols.filter((s) => s.summaryStatus === "possibly_stale").length;

    const targetSymbolsCount = includePossiblyStale
      ? missingSymbols + staleSymbols + possiblyStaleSymbols
      : missingSymbols + staleSymbols;

    // Token math: ~300 tokens in per function, ~60 out; ~500 in per file, ~100 out
    const estimatedTokensIn = targetSymbolsCount * 300 + files.length * 500 + 1500;
    const estimatedTokensOut = targetSymbolsCount * 60 + files.length * 100 + 400;

    // Pricing calculation
    let estimatedCostUsd = 0;
    if (provider === "gemini") {
      // Gemini 2.0 Flash: $0.10/M tokens in, $0.40/M tokens out (assuming paid tier; free tier is $0)
      estimatedCostUsd = (estimatedTokensIn / 1_000_000) * 0.10 + (estimatedTokensOut / 1_000_000) * 0.40;
    }

    // Estimated time (assuming 2.5s per batch of 10 items)
    const batches = Math.ceil(targetSymbolsCount / 8) + Math.ceil(files.length / 5) + 1;
    const estimatedDurationSec = Math.max(5, batches * 2);

    return {
      nodesByLevel,
      totalSymbols: symbols.length,
      totalFiles: files.length,
      staleSymbols,
      missingSymbols,
      estimatedTokensIn,
      estimatedTokensOut,
      estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
      estimatedDurationSec
    };
  }

  public static printEstimate(est: SummarizeEstimate, provider = "gemini", model = "gemini-2.0-flash"): void {
    console.log(`\n==========================================================`);
    console.log(`  OSS Analyser: Summarization Pre-Flight Estimate`);
    console.log(`==========================================================`);
    console.log(`Provider / Model   : ${provider} (${model})`);
    console.log(`Total Symbols      : ${est.totalSymbols} across ${est.totalFiles} files`);
    console.log(`Targets to Process : ${est.missingSymbols} missing, ${est.staleSymbols} stale`);
    console.log(`Topological Levels :`);
    for (const [lvl, count] of Object.entries(est.nodesByLevel)) {
      console.log(`  • Level ${lvl}         : ${count} symbol(s)`);
    }
    console.log(`----------------------------------------------------------`);
    console.log(`Estimated Tokens In : ~${est.estimatedTokensIn.toLocaleString()} tokens`);
    console.log(`Estimated Tokens Out: ~${est.estimatedTokensOut.toLocaleString()} tokens`);
    console.log(`Estimated Cost      : $${est.estimatedCostUsd.toFixed(4)} USD (or Free Tier)`);
    console.log(`Estimated Duration  : ~${est.estimatedDurationSec}s`);
    console.log(`==========================================================\n`);
  }
}
