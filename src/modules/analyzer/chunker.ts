import type {
  TopoLevel,
  LLMChunkBatch,
  LLMPromptItem,
  ChunkerOptions
} from "../../core/types.js";

/**
 * Packs topological levels into LLM chunk batches while strictly keeping
 * SCC groups together whenever they fit within the token budget.
 */
export function packTopoLevelsIntoLLMBatches(
  topoLevels: TopoLevel[],
  options: ChunkerOptions = {},
  existingSummaries: Map<string, string> = new Map()
): LLMChunkBatch[] {
  const { maxTokensPerBatch = 24000, maxItemsPerBatch = 25 } = options;

  const batches: LLMChunkBatch[] = [];
  let batchCounter = 1;

  for (const { level, components } of topoLevels) {
    let currentBatch: LLMChunkBatch = {
      batchId: `batch_L${level}_${batchCounter++}`,
      level,
      totalTokens: 0,
      items: [],
      sccComponentIds: [],
      hasCyclicGroup: false
    };

    for (const comp of components) {
      const itemsForComponent: LLMPromptItem[] = comp.nodes.map((node) => {
        const depSummaries: Record<string, string> = {};
        for (const depId of node.dependencies) {
          if (existingSummaries.has(depId)) {
            depSummaries[depId] = existingSummaries.get(depId)!;
          }
        }

        return {
          nodeId: node.id,
          label: node.label,
          sourceFile: node.source_file,
          rawCode: node.raw_code || `// Code for ${node.label} in ${node.source_file}`,
          signature: node.signature,
          estimatedTokens: node.estimated_tokens,
          isCyclicGroupMember: comp.isCyclic,
          cycleGroupIds: comp.isCyclic ? [...comp.nodeIds] : undefined,
          dependencySummaries: Object.keys(depSummaries).length > 0 ? depSummaries : undefined
        };
      });

      const compTokens = comp.totalTokens;

      if (compTokens <= maxTokensPerBatch) {
        const wouldExceedTokens = currentBatch.totalTokens + compTokens > maxTokensPerBatch;
        const wouldExceedItems = currentBatch.items.length + itemsForComponent.length > maxItemsPerBatch;

        if ((wouldExceedTokens || wouldExceedItems) && currentBatch.items.length > 0) {
          batches.push(currentBatch);
          currentBatch = {
            batchId: `batch_L${level}_${batchCounter++}`,
            level,
            totalTokens: 0,
            items: [],
            sccComponentIds: [],
            hasCyclicGroup: false
          };
        }

        currentBatch.items.push(...itemsForComponent);
        currentBatch.totalTokens += compTokens;
        currentBatch.sccComponentIds.push(comp.id);
        if (comp.isCyclic) {
          currentBatch.hasCyclicGroup = true;
        }
      } else {
        if (currentBatch.items.length > 0) {
          batches.push(currentBatch);
          currentBatch = {
            batchId: `batch_L${level}_${batchCounter++}`,
            level,
            totalTokens: 0,
            items: [],
            sccComponentIds: [],
            hasCyclicGroup: false
          };
        }

        let splitBatch: LLMChunkBatch = {
          batchId: `batch_L${level}_${batchCounter++}_oversized_scc`,
          level,
          totalTokens: 0,
          items: [],
          sccComponentIds: [comp.id],
          hasCyclicGroup: true
        };

        for (const item of itemsForComponent) {
          if (
            splitBatch.items.length > 0 &&
            (splitBatch.totalTokens + item.estimatedTokens > maxTokensPerBatch ||
              splitBatch.items.length >= maxItemsPerBatch)
          ) {
            batches.push(splitBatch);
            splitBatch = {
              batchId: `batch_L${level}_${batchCounter++}_oversized_scc`,
              level,
              totalTokens: 0,
              items: [],
              sccComponentIds: [comp.id],
              hasCyclicGroup: true
            };
          }
          splitBatch.items.push(item);
          splitBatch.totalTokens += item.estimatedTokens;
        }

        if (splitBatch.items.length > 0) {
          batches.push(splitBatch);
        }
      }
    }

    if (currentBatch.items.length > 0) {
      batches.push(currentBatch);
    }
  }

  return batches;
}

/**
 * Formats an LLMChunkBatch into a clear prompt payload for Gemini.
 */
export function formatBatchToPrompt(batch: LLMChunkBatch): string {
  const parts: string[] = [];

  parts.push(`You are analyzing a codebase to generate technical summaries for developer onboarding.`);
  parts.push(`Generation Level: Level ${batch.level} (Bottom-Up order).`);

  if (batch.hasCyclicGroup) {
    parts.push(`NOTE: This batch contains mutually recursive or cyclically dependent functions (SCC group).`);
    parts.push(`Explain how they interact and call each other in addition to their individual purposes.`);
  }

  parts.push(`\nPlease provide a concise JSON array of summaries for the following functions/methods:`);

  for (const item of batch.items) {
    parts.push(`\n--- Function: ${item.label} (ID: ${item.nodeId}) ---`);
    parts.push(`File: ${item.sourceFile}`);
    if (item.isCyclicGroupMember) {
      parts.push(`Cycle Group Members: [${item.cycleGroupIds?.join(", ")}]`);
    }

    if (item.dependencySummaries && Object.keys(item.dependencySummaries).length > 0) {
      parts.push(`Callees already summarized:`);
      for (const [depId, summary] of Object.entries(item.dependencySummaries)) {
        parts.push(`  - ${depId}: "${summary}"`);
      }
    }

    parts.push(`Code:\n\`\`\`\n${item.rawCode}\n\`\`\``);
  }

  parts.push(`\nRespond strictly with JSON schema:
[
  {
    "nodeId": "<nodeId>",
    "summary": "<1-3 sentence technical summary of responsibility and behavior>",
    "inputs": "<parameters and types>",
    "outputs": "<return value>",
    "sideEffects": "<e.g. database query, network call, console log, none>"
  }
]`);

  return parts.join("\n");
}
