import * as path from "node:path";
import type { GraphStore, NodeRecord } from "../storage/graphStore.js";
import type { LlmProvider } from "./provider.js";
import { HeuristicProvider } from "./providers/heuristic.js";
import { InvalidationManager, CURRENT_PROMPT_VERSION } from "../pipeline/invalidation.js";
import { condenseGraphWithTarjan } from "../modules/analyzer/tarjan.js";
import { computeBottomUpTopoLevels } from "../modules/analyzer/topoSort.js";
import { packTopoLevelsIntoLLMBatches, formatBatchToPrompt } from "../modules/analyzer/chunker.js";
import type { CodeNode } from "../core/types.js";

export interface SummarizePipelineOptions {
  repoId: string;
  repoRoot: string;
  provider: LlmProvider;
  includePossiblyStale?: boolean;
  onProgress?: (stage: string, current: number, total: number) => void;
}

export interface SummarizeStats {
  functionsSummarized: number;
  filesSummarized: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export async function runSummarizationPipeline(
  store: GraphStore,
  options: SummarizePipelineOptions
): Promise<SummarizeStats> {
  const startTime = Date.now();
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let functionsSummarizedCount = 0;
  let filesSummarizedCount = 0;

  const repo = await store.getRepository(options.repoId);
  const repoName = repo?.name || path.basename(options.repoRoot);

  // 1. Load all nodes
  const allNodes = await store.getAllNodes(options.repoId);
  const symbolNodes = allNodes.filter(
    (n) => n.nodeType === "function" || n.nodeType === "method" || n.nodeType === "class"
  );
  const fileNodes = allNodes.filter((n) => n.nodeType === "file");

  // Summary cache for callee injection
  const summaryCache = new Map<string, string>();
  const contentHashCache = new Map<string, string>();

  for (const sym of symbolNodes) {
    if (sym.summary && sym.summary !== "pending_summary") {
      summaryCache.set(sym.id, sym.summary);
      if (sym.summaryContentHash) {
        contentHashCache.set(sym.id, sym.summaryContentHash);
      }
    }
  }

  // 2. Build graph for Tarjan & TopoSort
  const symbolMap = new Map<string, CodeNode>();
  for (const sym of symbolNodes) {
    const deps = await store.getDependencies(sym.id, 1, false);
    symbolMap.set(sym.id, {
      id: sym.id,
      label: sym.name,
      dependencies: deps.map((d) => d.id),
      source_file: sym.filePath,
      start_line: sym.startLine ?? undefined,
      end_line: sym.endLine ?? undefined,
      raw_code: sym.rawCode ?? undefined,
      signature: sym.signature ?? undefined,
      file_type: "code",
      is_callable: sym.nodeType === "function" || sym.nodeType === "method",
      is_class: sym.nodeType === "class",
      callers: [],
      estimated_tokens: 0
    });
  }

  const dag = condenseGraphWithTarjan(symbolMap);
  const topoResult = computeBottomUpTopoLevels(dag);

  // 3. Process Levels bottom-up (0 -> K)
  const totalLevels = topoResult.levels.length;

  for (let lvlIdx = 0; lvlIdx < totalLevels; lvlIdx++) {
    const levelInfo = topoResult.levels[lvlIdx];
    if (options.onProgress) {
      options.onProgress("functions", lvlIdx + 1, totalLevels);
    }

    const batches = packTopoLevelsIntoLLMBatches(
      [{ level: levelInfo.level, components: levelInfo.components }],
      { maxTokensPerBatch: 24000, maxItemsPerBatch: 25 },
      summaryCache
    );

    for (const batch of batches) {
      // Filter items needing summarization
      const itemsToSummarize = batch.items.filter((item) => {
        const existingNode = symbolNodes.find((n) => n.id === item.nodeId);
        if (!existingNode) return true;

        if (existingNode.summaryStatus === "missing" || !existingNode.summary || existingNode.summary === "pending_summary") {
          return true;
        }
        if (existingNode.summaryStatus === "stale") {
          return true;
        }
        if (options.includePossiblyStale && existingNode.summaryStatus === "possibly_stale") {
          return true;
        }
        return false;
      });

      if (itemsToSummarize.length === 0) {
        // Zero-token resume: All items in batch already have fresh summaries!
        continue;
      }

      // Generate prompt for the unsummarized items
      const subBatch = { ...batch, items: itemsToSummarize };
      const prompt = formatBatchToPrompt(subBatch);

      let summariesMap = new Map<string, string>();
      let usedHeuristic = false;

      try {
        const response = await options.provider.complete({
          prompt,
          maxTokens: 2500,
          json: true
        });

        totalTokensIn += response.tokensIn;
        totalTokensOut += response.tokensOut;

        try {
          const parsed = JSON.parse(response.text);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (item.nodeId && item.summary) {
                summariesMap.set(item.nodeId, item.summary);
              }
            }
          } else if (parsed.functions && Array.isArray(parsed.functions)) {
            for (const item of parsed.functions) {
              if (item.nodeId && item.summary) {
                summariesMap.set(item.nodeId, item.summary);
              }
            }
          }
        } catch {
          // JSON parsing failed; fall back
          usedHeuristic = true;
        }
      } catch (err: any) {
        // Provider call failed; fall back to heuristic AST summaries
        usedHeuristic = true;
      }

      // Commit batch results to store
      for (const item of itemsToSummarize) {
        let summaryText = summariesMap.get(item.nodeId);
        if (!summaryText || usedHeuristic) {
          const deps = symbolMap.get(item.nodeId)?.dependencies || [];
          const depLabels = deps.map((d) => symbolMap.get(d)?.label || d);
          summaryText = HeuristicProvider.generateFunctionSummary(
            item.label,
            item.signature || "",
            undefined,
            depLabels
          );
        }

        const existingNode = symbolNodes.find((n) => n.id === item.nodeId);
        const oldContentHash = existingNode?.summaryContentHash || "";
        const newContentHash = InvalidationManager.computeSummaryContentHash(summaryText);

        // Fetch deterministic callee hashes
        const calleeHashes: string[] = [];
        const deps = symbolMap.get(item.nodeId)?.dependencies || [];
        for (const depId of deps) {
          const cHash = contentHashCache.get(depId);
          if (cHash) calleeHashes.push(cHash);
        }

        const newInputHash = InvalidationManager.computeSymbolInputHash(
          existingNode?.sourceHash || "",
          calleeHashes,
          CURRENT_PROMPT_VERSION
        );

        // Check if content hash changed: if so, mark direct callers possibly_stale
        if (oldContentHash && oldContentHash !== newContentHash) {
          await store.markCallersPossiblyStale(item.nodeId);
        }

        const finalStatus = usedHeuristic || options.provider.name === "heuristic" ? "heuristic" : "fresh";

        await store.updateSummaryStatus(item.nodeId, finalStatus, {
          summary: summaryText,
          inputHash: newInputHash,
          contentHash: newContentHash
        });

        summaryCache.set(item.nodeId, summaryText);
        contentHashCache.set(item.nodeId, newContentHash);
        functionsSummarizedCount++;
      }
    }
  }

  // 4. File-level contracts
  if (options.onProgress) {
    options.onProgress("files", 1, fileNodes.length || 1);
  }

  for (const fNode of fileNodes) {
    const symbolsInFile = symbolNodes.filter((s) => s.filePath === fNode.filePath);
    const exportedSymbols = symbolsInFile.filter((s) => (s.metadata as any)?.exported);
    const fileSummary = HeuristicProvider.generateFileContract(
      fNode.filePath,
      exportedSymbols.map((s) => s.name)
    );

    await store.updateSummaryStatus(fNode.id, "fresh", {
      summary: fileSummary,
      contentHash: InvalidationManager.computeSummaryContentHash(fileSummary)
    });
    filesSummarizedCount++;
  }

  // 5. Repo Architecture & Onboarding Guide
  const fileContracts = fileNodes.slice(0, 10).map((f) => `${f.filePath}: ${f.summary || "Module"}`).join("\n");
  const repoArchSummary = `Modular architecture for ${repoName} with ${fileNodes.length} files and ${symbolNodes.length} symbols.\nKey components:\n${fileContracts}`;
  const onboardingGuide = `### Developer Onboarding Guide for ${repoName}\n\n1. Project Architecture:\n${repoArchSummary}\n\n2. Key Modules:\n${fileNodes.slice(0, 5).map((f) => `- \`${f.filePath}\`: ${f.summary}`).join("\n")}`;

  await store.saveRepository({
    id: options.repoId,
    name: repoName,
    rootPath: options.repoRoot,
    status: "summarized",
    architectureSummary: repoArchSummary,
    onboardingGuide: onboardingGuide,
    indexedAt: new Date().toISOString()
  });

  return {
    functionsSummarized: functionsSummarizedCount,
    filesSummarized: filesSummarizedCount,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    durationMs: Date.now() - startTime
  };
}
