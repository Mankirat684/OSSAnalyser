import * as path from "node:path";
import type {
  AnalyzerPipelineResult,
  ChunkerOptions,
  FunctionSummary,
  FileSummary,
  DirectorySummary,
  RepoSummary,
  CodebaseSummaryResult
} from "../../core/types.js";
import { packTopoLevelsIntoLLMBatches, formatBatchToPrompt } from "../analyzer/index.js";
import { GeminiSummarizerClient } from "./geminiClient.js";

export interface HierarchicalSummarizerOptions {
  repoName?: string;
  repoRoot?: string;
  chunkerOptions?: ChunkerOptions;
  existingSummaries?: Map<string, FunctionSummary>;
  onBatchCompleted?: (batchSummaries: FunctionSummary[], currentLevel: number, totalLevels: number) => Promise<void>;
  onProgress?: (stage: string, current: number, total: number) => void;
}

export async function summarizeCodebaseHierarchically(
  analyzerResult: AnalyzerPipelineResult,
  gemini: GeminiSummarizerClient,
  options: HierarchicalSummarizerOptions = {}
): Promise<CodebaseSummaryResult> {
  const startTime = Date.now();
  const repoName = options.repoName || "Codebase";
  const repoRoot = options.repoRoot || process.cwd();

  // Initialize with any previously completed summaries (checkpoint resumption)
  const functionSummaries = new Map<string, FunctionSummary>(options.existingSummaries || []);
  const summaryCache = new Map<string, string>();
  for (const [id, fn] of functionSummaries.entries()) {
    summaryCache.set(id, fn.summary);
  }

  // ---------------------------------------------------------------------------
  // STEP 1: Bottom-up Function Summarization (Topo Level 0 -> Level k)
  // ---------------------------------------------------------------------------
  const totalLevels = analyzerResult.topoLevels.length;

  for (let lvlIdx = 0; lvlIdx < totalLevels; lvlIdx++) {
    const levelInfo = analyzerResult.topoLevels[lvlIdx];
    const levelComponents = levelInfo.components.map(
      (c) => analyzerResult.dag.components.get(c.id)!
    );

    const batches = packTopoLevelsIntoLLMBatches(
      [{ level: levelInfo.level, components: levelComponents }],
      options.chunkerOptions,
      summaryCache
    );

    for (const batch of batches) {
      if (options.onProgress) {
        options.onProgress("functions", lvlIdx + 1, totalLevels);
      }

      // Filter out items already summarized in a previous checkpoint
      const unsummarizedItems = batch.items.filter((item) => !summaryCache.has(item.nodeId));
      const newSummariesInBatch: FunctionSummary[] = [];

      if (unsummarizedItems.length > 0) {
        const batchToPrompt = { ...batch, items: unsummarizedItems };
        const prompt = formatBatchToPrompt(batchToPrompt);

        interface RawFnResponse {
          nodeId: string;
          summary: string;
          inputs?: string;
          outputs?: string;
          sideEffects?: string;
        }

        const response = await gemini.generateJson<RawFnResponse[]>(prompt, () =>
          unsummarizedItems.map((item) => ({
            nodeId: item.nodeId,
            summary: `Handles ${item.label.replace(/[().]/g, "")} operations within ${path.basename(item.sourceFile)}.`,
            inputs: "Inferred from parameters",
            outputs: "Computed result or domain model",
            sideEffects: item.rawCode.includes("console.log") ? "Console logging" : "None"
          }))
        );

        for (const res of response) {
          const originalNode = analyzerResult.rawNodes.get(res.nodeId);
          const compId = analyzerResult.dag.nodeToComponent.get(res.nodeId);
          const comp = compId ? analyzerResult.dag.components.get(compId) : undefined;

          const fnSummary: FunctionSummary = {
            nodeId: res.nodeId,
            label: originalNode?.label || res.nodeId,
            sourceFile: originalNode?.source_file || "unknown",
            summary: res.summary,
            inputs: res.inputs,
            outputs: res.outputs,
            sideEffects: res.sideEffects,
            level: batch.level,
            isCycleMember: comp?.isCyclic ?? false
          };

          functionSummaries.set(res.nodeId, fnSummary);
          summaryCache.set(res.nodeId, res.summary);
          newSummariesInBatch.push(fnSummary);
        }
      }

      // Checkpoint trigger: commit newly summarized functions immediately to DB!
      if (newSummariesInBatch.length > 0 && options.onBatchCompleted) {
        await options.onBatchCompleted(newSummariesInBatch, lvlIdx + 1, totalLevels);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // STEP 2: File-Level Rollup
  // ---------------------------------------------------------------------------
  const fileNodesMap = new Map<string, FunctionSummary[]>();
  for (const fn of functionSummaries.values()) {
    if (!fileNodesMap.has(fn.sourceFile)) {
      fileNodesMap.set(fn.sourceFile, []);
    }
    fileNodesMap.get(fn.sourceFile)!.push(fn);
  }

  const fileSummaries = new Map<string, FileSummary>();
  const fileList = Array.from(fileNodesMap.entries());

  for (let i = 0; i < fileList.length; i++) {
    const [filePath, fns] = fileList[i];
    if (options.onProgress) {
      options.onProgress("files", i + 1, fileList.length);
    }

    const fnDescriptions = fns.map((f) => `  * ${f.label}: ${f.summary}`).join("\n");
    const filePrompt = `You are generating a file-level architectural summary for developer onboarding.
File: ${filePath}
Functions and symbols declared in this file:
${fnDescriptions}

Provide a concise JSON summary explaining the single responsibility of this file and its public exported contract:
{
  "summary": "<2-3 sentence overview of what this file is responsible for>",
  "purpose": "<Primary domain responsibility, e.g. Data Access, Business Logic, Utilities, or Interface>",
  "exportedSymbols": ["<list of key exported symbols>"]
}`;

    interface RawFileResponse {
      summary: string;
      purpose: string;
      exportedSymbols: string[];
    }

    const fileRes = await gemini.generateJson<RawFileResponse>(filePrompt, () => ({
      summary: `Defines ${fns.map((f) => f.label).join(", ")} providing core functionality for ${path.basename(filePath)}.`,
      purpose: filePath.includes("service")
        ? "Business Logic"
        : filePath.includes("repo")
        ? "Data Access Layer"
        : "Utility / Support",
      exportedSymbols: fns.map((f) => f.label)
    }));

    const fnSummaryMap: Record<string, string> = {};
    for (const f of fns) {
      fnSummaryMap[f.nodeId] = f.summary;
    }

    fileSummaries.set(filePath, {
      filePath,
      summary: fileRes.summary,
      purpose: fileRes.purpose,
      exportedSymbols: fileRes.exportedSymbols,
      functionCount: fns.length,
      functionSummaries: fnSummaryMap
    });
  }

  // ---------------------------------------------------------------------------
  // STEP 3: Directory / Module-Level Rollup
  // ---------------------------------------------------------------------------
  const dirFilesMap = new Map<string, FileSummary[]>();
  for (const fileSummary of fileSummaries.values()) {
    const dir = path.dirname(fileSummary.filePath).replace(/\\/g, "/");
    if (!dirFilesMap.has(dir)) {
      dirFilesMap.set(dir, []);
    }
    dirFilesMap.get(dir)!.push(fileSummary);
  }

  const directorySummaries = new Map<string, DirectorySummary>();
  const dirList = Array.from(dirFilesMap.entries());

  for (let i = 0; i < dirList.length; i++) {
    const [dirPath, files] = dirList[i];
    if (options.onProgress) {
      options.onProgress("directories", i + 1, dirList.length);
    }

    const fileDescs = files.map((f) => `  * ${path.basename(f.filePath)}: ${f.summary}`).join("\n");
    const dirPrompt = `You are generating a directory/module summary for developer onboarding.
Directory: ${dirPath}
Files in this module:
${fileDescs}

Provide a concise JSON summary explaining what role this directory plays in the system:
{
  "summary": "<2-3 sentence overview of this module's domain responsibility>",
  "responsibility": "<High-level subsystem category, e.g. Domain Services, Persistence Layer, Shared Helpers>"
}`;

    interface RawDirResponse {
      summary: string;
      responsibility: string;
    }

    const dirRes = await gemini.generateJson<RawDirResponse>(dirPrompt, () => ({
      summary: `Contains files related to ${path.basename(dirPath)} domain operations.`,
      responsibility: `${path.basename(dirPath).toUpperCase()} Subsystem`
    }));

    directorySummaries.set(dirPath, {
      dirPath,
      summary: dirRes.summary,
      responsibility: dirRes.responsibility,
      files: files.map((f) => f.filePath)
    });
  }

  // ---------------------------------------------------------------------------
  // STEP 4: Repository / Architecture-Level Rollup
  // ---------------------------------------------------------------------------
  const dirDescriptions = Array.from(directorySummaries.values())
    .map((d) => `  * ${d.dirPath} (${d.responsibility}): ${d.summary}`)
    .join("\n");

  const repoPrompt = `You are an expert software architect writing a codebase onboarding guide for new developers.
Repository: ${repoName}
Subsystems / Directories:
${dirDescriptions}

Provide a comprehensive JSON overview for new engineers onboarding to the codebase:
{
  "summary": "<High-level 2-3 sentence summary of what this application/library is>",
  "architecture": "<Architectural pattern used, e.g. Layered Clean Architecture, Service-Repository, Modular>",
  "onboardingGuide": "<Step-by-step guidance on how the code flows and where a new developer should start reading>",
  "subsystems": [
    {
      "name": "<Subsystem name>",
      "description": "<What it handles>"
    }
  ]
}`;

  interface RawRepoResponse {
    summary: string;
    architecture: string;
    onboardingGuide: string;
    subsystems: Array<{ name: string; description: string }>;
  }

  const repoRes = await gemini.generateJson<RawRepoResponse>(repoPrompt, () => ({
    summary: `${repoName} provides a structured TypeScript service and repository architecture with domain models and utility formatters.`,
    architecture: "Layered Service-Repository Pattern",
    onboardingGuide:
      "Start by inspecting domain models, then explore the repositories for data retrieval, and finally review the services layer where business orchestration takes place.",
    subsystems: Array.from(directorySummaries.values()).map((d) => ({
      name: d.dirPath,
      description: d.summary
    }))
  }));

  const repoSummary: RepoSummary = {
    name: repoName,
    summary: repoRes.summary,
    architecture: repoRes.architecture,
    onboardingGuide: repoRes.onboardingGuide,
    subsystems: repoRes.subsystems
  };

  const durationMs = Date.now() - startTime;

  return {
    repoName,
    rootPath: repoRoot,
    functions: functionSummaries,
    files: fileSummaries,
    directories: directorySummaries,
    repo: repoSummary,
    stats: {
      totalFunctions: functionSummaries.size,
      totalFiles: fileSummaries.size,
      totalDirectories: directorySummaries.size,
      llmCallCount: gemini.callCount,
      durationMs
    }
  };
}
