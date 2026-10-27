import { loadAndParseGraph } from "./graphParser.js";
import { condenseGraphWithTarjan } from "./tarjan.js";
import { computeBottomUpTopoLevels } from "./topoSort.js";
import { packTopoLevelsIntoLLMBatches } from "./chunker.js";
import type {
  ParseGraphOptions,
  ChunkerOptions,
  AnalyzerPipelineResult
} from "../../core/types.js";

export function runAnalyzerPipeline(
  parseOptions: ParseGraphOptions,
  chunkerOptions?: ChunkerOptions
): AnalyzerPipelineResult {
  const { nodes, edges } = loadAndParseGraph(parseOptions);
  const dag = condenseGraphWithTarjan(nodes);
  const { levels } = computeBottomUpTopoLevels(dag);
  const batches = packTopoLevelsIntoLLMBatches(levels, chunkerOptions);

  const cyclicSCCs: AnalyzerPipelineResult["cyclicSCCs"] = [];
  for (const comp of dag.components.values()) {
    if (comp.isCyclic) {
      cyclicSCCs.push({
        id: comp.id,
        nodeCount: comp.nodeIds.length,
        nodeIds: comp.nodeIds,
        labels: comp.nodes.map((n) => n.label),
        totalTokens: comp.totalTokens
      });
    }
  }

  const formattedLevels = levels.map((lvl) => ({
    level: lvl.level,
    componentCount: lvl.components.length,
    nodeCount: lvl.components.reduce((sum, c) => sum + c.nodeIds.length, 0),
    components: lvl.components.map((c) => ({
      id: c.id,
      isCyclic: c.isCyclic,
      nodeIds: c.nodeIds,
      labels: c.nodes.map((n) => n.label),
      dependencies: Array.from(c.dependencies)
    }))
  }));

  return {
    totalNodes: nodes.size,
    totalEdges: edges.length,
    sccCount: dag.components.size,
    cyclicSCCs,
    topoLevels: formattedLevels,
    batches,
    rawNodes: nodes,
    dag
  };
}
