import * as path from "node:path";
import * as fs from "node:fs";
import type { GraphStore, NodeRecord } from "../storage/graphStore.js";
import type { CodeNode } from "../core/types.js";
import { condenseGraphWithTarjan } from "../modules/analyzer/tarjan.js";
import { computeBottomUpTopoLevels } from "../modules/analyzer/topoSort.js";
import { packTopoLevelsIntoLLMBatches, formatBatchToPrompt } from "../modules/analyzer/chunker.js";
import { InvalidationManager, CURRENT_PROMPT_VERSION } from "../pipeline/invalidation.js";
import { HeuristicProvider } from "./providers/heuristic.js";

export interface AgentBatchItem {
  nodeId: string;
  label: string;
  filePath: string;
  signature?: string;
}

export interface NextBatchResult {
  hasMore: boolean;
  level?: number;
  totalLevels?: number;
  totalMissing?: number;
  prompt?: string;
  items?: AgentBatchItem[];
  message?: string;
}

export interface SaveBatchResult {
  saved: number;
  remainingMissing: number;
  completed: boolean;
  message: string;
}

/**
 * Builds the topological DAG and summary caches for a repository.
 */
async function buildRepoTopoState(store: GraphStore, repoId: string, repoRoot: string) {
  const allNodes = await store.getAllNodes(repoId);
  const symbolNodes = allNodes.filter(
    (n) => n.nodeType === "function" || n.nodeType === "method" || n.nodeType === "class"
  );
  const fileNodes = allNodes.filter((n) => n.nodeType === "file");

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

  const symbolMap = new Map<string, CodeNode>();
  for (const sym of symbolNodes) {
    const deps = await store.getDependencies(sym.id, 1, false);
    let rawCode = sym.rawCode;
    if (!rawCode && sym.filePath && sym.startLine != null && sym.endLine != null) {
      try {
        const fullPath = path.resolve(repoRoot, sym.filePath);
        if (fs.existsSync(fullPath)) {
          const lines = fs.readFileSync(fullPath, "utf-8").split("\n");
          rawCode = lines.slice(Math.max(0, sym.startLine - 1), Math.min(lines.length, sym.endLine)).join("\n");
        }
      } catch {
        // Fallback if file read fails
      }
    }

    symbolMap.set(sym.id, {
      id: sym.id,
      label: sym.name,
      dependencies: deps.map((d) => d.id),
      source_file: sym.filePath,
      start_line: sym.startLine ?? undefined,
      end_line: sym.endLine ?? undefined,
      raw_code: rawCode ?? undefined,
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

  return {
    symbolNodes,
    fileNodes,
    symbolMap,
    summaryCache,
    contentHashCache,
    topoResult
  };
}

export interface AgentBatchOptions {
  maxItemsPerBatch?: number;
  includePossiblyStale?: boolean;
  filePath?: string;
}

/**
 * Resets summaries to 'missing' so they can be re-summarized from scratch by the harness.
 */
export async function resetRepoSummaries(
  store: GraphStore,
  repoId: string,
  options: { scope?: "all" | "possibly_stale" | "heuristic"; filePath?: string } = {}
): Promise<{ resetCount: number; message: string }> {
  const allNodes = await store.getAllNodes(repoId);
  const scope = options.scope || "all";
  let targetNodes = allNodes.filter(
    (n) => n.nodeType === "function" || n.nodeType === "method" || n.nodeType === "class"
  );

  if (options.filePath) {
    targetNodes = targetNodes.filter((n) => n.filePath === options.filePath);
  }

  if (scope === "possibly_stale") {
    targetNodes = targetNodes.filter((n) => n.summaryStatus === "possibly_stale");
  } else if (scope === "heuristic") {
    targetNodes = targetNodes.filter((n) => n.summaryStatus === "heuristic");
  }

  for (const node of targetNodes) {
    node.summary = "pending_summary";
    node.summaryStatus = "missing";
    node.summaryContentHash = undefined;
    node.summaryInputHash = undefined;
  }

  await store.upsertNodes(targetNodes);

  return {
    resetCount: targetNodes.length,
    message: `Reset ${targetNodes.length} symbols to 'missing' (scope: ${scope}). They are now queued for re-summarization.`
  };
}

/**
 * Retrieves the next topological batch of symbols needing summary.
 */
export async function getNextAgentBatch(
  store: GraphStore,
  repoId: string,
  repoRoot: string,
  optionsOrMaxItems: AgentBatchOptions | number = {}
): Promise<NextBatchResult> {
  const options: AgentBatchOptions =
    typeof optionsOrMaxItems === "number"
      ? { maxItemsPerBatch: optionsOrMaxItems }
      : optionsOrMaxItems;

  const maxItemsPerBatch = options.maxItemsPerBatch ?? 25;
  const state = await buildRepoTopoState(store, repoId, repoRoot);

  const missingNodes = state.symbolNodes.filter((n) => {
    if (options.filePath && n.filePath !== options.filePath) return false;
    if (
      n.summaryStatus === "missing" ||
      n.summaryStatus === "stale" ||
      !n.summary ||
      n.summary === "pending_summary"
    ) {
      return true;
    }
    if (options.includePossiblyStale && n.summaryStatus === "possibly_stale") {
      return true;
    }
    return false;
  });

  if (missingNodes.length === 0) {
    return {
      hasMore: false,
      totalMissing: 0,
      message: "All symbols in repository already have fresh summaries. Codebase is 100% summarized!"
    };
  }

  const totalLevels = state.topoResult.levels.length;

  for (let lvlIdx = 0; lvlIdx < totalLevels; lvlIdx++) {
    const levelInfo = state.topoResult.levels[lvlIdx];

    const batches = packTopoLevelsIntoLLMBatches(
      [{ level: levelInfo.level, components: levelInfo.components }],
      { maxTokensPerBatch: 24000, maxItemsPerBatch: maxItemsPerBatch },
      state.summaryCache
    );

    for (const batch of batches) {
      const itemsToSummarize = batch.items.filter((item) => {
        const existingNode = state.symbolNodes.find((n) => n.id === item.nodeId);
        if (!existingNode) return true;
        if (options.filePath && existingNode.filePath !== options.filePath) return false;
        if (
          existingNode.summaryStatus === "missing" ||
          existingNode.summaryStatus === "stale" ||
          !existingNode.summary ||
          existingNode.summary === "pending_summary"
        ) {
          return true;
        }
        if (options.includePossiblyStale && existingNode.summaryStatus === "possibly_stale") {
          return true;
        }
        return false;
      });

      if (itemsToSummarize.length > 0) {
        const subBatch = { ...batch, items: itemsToSummarize };
        const prompt = formatBatchToPrompt(subBatch);

        return {
          hasMore: true,
          level: levelInfo.level,
          totalLevels,
          totalMissing: missingNodes.length,
          prompt,
          items: itemsToSummarize.map((it) => ({
            nodeId: it.nodeId,
            label: it.label,
            filePath: it.sourceFile,
            signature: it.signature
          }))
        };
      }
    }
  }

  return {
    hasMore: false,
    totalMissing: 0,
    message: "No unsummarized batches remaining."
  };
}

/**
 * Saves a batch of harness-generated summaries into SQLite and updates callee/caller state.
 */
export async function saveAgentBatch(
  store: GraphStore,
  repoId: string,
  repoRoot: string,
  summaries: Array<{ nodeId: string; summary: string }>
): Promise<SaveBatchResult> {
  const state = await buildRepoTopoState(store, repoId, repoRoot);
  let savedCount = 0;

  for (const item of summaries) {
    if (!item.nodeId || !item.summary) continue;

    const existingNode = state.symbolNodes.find((n) => n.id === item.nodeId);
    const oldContentHash = existingNode?.summaryContentHash || "";
    const newContentHash = InvalidationManager.computeSummaryContentHash(item.summary);

    // Compute input hash
    const calleeHashes: string[] = [];
    const deps = state.symbolMap.get(item.nodeId)?.dependencies || [];
    for (const depId of deps) {
      const cHash = state.contentHashCache.get(depId);
      if (cHash) calleeHashes.push(cHash);
    }

    const newInputHash = InvalidationManager.computeSymbolInputHash(
      existingNode?.sourceHash || "",
      calleeHashes,
      CURRENT_PROMPT_VERSION
    );

    if (oldContentHash && oldContentHash !== newContentHash) {
      await store.markCallersPossiblyStale(item.nodeId);
    }

    await store.updateSummaryStatus(item.nodeId, "fresh", {
      summary: item.summary,
      inputHash: newInputHash,
      contentHash: newContentHash
    });

    state.summaryCache.set(item.nodeId, item.summary);
    state.contentHashCache.set(item.nodeId, newContentHash);
    savedCount++;
  }

  // Check how many remain unsummarized
  const allNodesAfter = await store.getAllNodes(repoId);
  const missingAfter = allNodesAfter
    .filter((n) => n.nodeType === "function" || n.nodeType === "method" || n.nodeType === "class")
    .filter((n) => n.summaryStatus === "missing" || n.summaryStatus === "stale" || !n.summary || n.summary === "pending_summary");

  const isCompleted = missingAfter.length === 0;

  // If completed, automatically finalize file contracts and repository overview!
  if (isCompleted) {
    await finalizeRollups(store, repoId, repoRoot);
  }

  return {
    saved: savedCount,
    remainingMissing: missingAfter.length,
    completed: isCompleted,
    message: isCompleted
      ? `Successfully saved ${savedCount} summaries. All symbols are now summarized! File contracts and repo architecture overview rolled up.`
      : `Successfully saved ${savedCount} summaries. ${missingAfter.length} symbols remaining.`
  };
}

/**
 * Generates file contracts and top-level repository overview.
 */
export async function finalizeRollups(store: GraphStore, repoId: string, repoRoot: string): Promise<void> {
  const allNodes = await store.getAllNodes(repoId);
  const symbolNodes = allNodes.filter(
    (n) => n.nodeType === "function" || n.nodeType === "method" || n.nodeType === "class"
  );
  const fileNodes = allNodes.filter((n) => n.nodeType === "file");
  const repo = await store.getRepository(repoId);
  const repoName = repo?.name || path.basename(repoRoot);

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
  }

  const fileContracts = fileNodes
    .slice(0, 10)
    .map((f) => `${f.filePath}: ${f.summary || "Module"}`)
    .join("\n");
  const repoArchSummary = `Modular architecture for ${repoName} with ${fileNodes.length} files and ${symbolNodes.length} symbols.\nKey components:\n${fileContracts}`;
  const onboardingGuide = `### Developer Onboarding Guide for ${repoName}\n\n1. Project Architecture:\n${repoArchSummary}\n\n2. Key Modules:\n${fileNodes.slice(0, 5).map((f) => `- \`${f.filePath}\`: ${f.summary}`).join("\n")}`;

  await store.saveRepository({
    id: repoId,
    name: repoName,
    rootPath: repoRoot,
    status: "summarized",
    architectureSummary: repoArchSummary,
    onboardingGuide: onboardingGuide,
    indexedAt: new Date().toISOString()
  });
}
