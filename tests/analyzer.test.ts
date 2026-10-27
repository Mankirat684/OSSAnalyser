import * as path from "node:path";
import {
  runAnalyzerPipeline,
  condenseGraphWithTarjan,
  computeBottomUpTopoLevels,
  packTopoLevelsIntoLLMBatches,
  formatBatchToPrompt
} from "../src/modules/analyzer/index.js";
import type { CodeNode } from "../src/core/types.js";

async function runTests() {
  console.log("==========================================================");
  console.log("  TEST: Analyzer (Tarjan's SCC, Topo Sort & Chunking)");
  console.log("==========================================================\n");

  const graphJsonPath = path.resolve(
    process.cwd(),
    "test_repos/graphify-ts-test/graphify-out/graph.json"
  );
  const repoRoot = path.resolve(process.cwd(), "test_repos/graphify-ts-test");

  console.log(`[Test 1] Testing on real repository: ${graphJsonPath}`);
  const result = runAnalyzerPipeline({
    graphJsonPath,
    repoRootPath: repoRoot,
    filterCallablesOnly: true
  });

  console.log(`✓ Loaded Nodes: ${result.totalNodes}`);
  console.log(`✓ Loaded Edges: ${result.totalEdges}`);
  console.log(`✓ Condensed SCC Components: ${result.sccCount}`);
  console.log(`✓ Topo Levels: ${result.topoLevels.length}`);

  for (const lvl of result.topoLevels) {
    console.log(`  --> Level ${lvl.level}: ${lvl.nodeCount} function(s) across ${lvl.componentCount} component(s)`);
  }

  console.log(`\n✓ Generated LLM Batches: ${result.batches.length}`);
  for (const b of result.batches) {
    console.log(`  --> Batch ${b.batchId} (Level ${b.level}, ${b.items.length} items, ${b.totalTokens} est. tokens)`);
  }

  // TEST 2: Mutual recursion cycle detection
  console.log("\n[Test 2] Testing explicit mutual cycle (funcA <-> funcB) with caller funcC");
  const mockNodes = new Map<string, CodeNode>();

  mockNodes.set("util_log", {
    id: "util_log",
    label: "log()",
    file_type: "code",
    source_file: "src/util.ts",
    is_callable: true,
    is_class: false,
    raw_code: "export function log(msg: string) { console.log(msg); }",
    estimated_tokens: 15,
    dependencies: [],
    callers: ["cycle_a"]
  });

  mockNodes.set("cycle_a", {
    id: "cycle_a",
    label: "funcA()",
    file_type: "code",
    source_file: "src/cycle.ts",
    is_callable: true,
    is_class: false,
    raw_code: "export function funcA(n: number): number { log(n); return n <= 0 ? 0 : funcB(n - 1); }",
    estimated_tokens: 30,
    dependencies: ["cycle_b", "util_log"],
    callers: ["cycle_b", "caller_c"]
  });

  mockNodes.set("cycle_b", {
    id: "cycle_b",
    label: "funcB()",
    file_type: "code",
    source_file: "src/cycle.ts",
    is_callable: true,
    is_class: false,
    raw_code: "export function funcB(n: number): number { return funcA(n / 2); }",
    estimated_tokens: 25,
    dependencies: ["cycle_a"],
    callers: ["cycle_a"]
  });

  mockNodes.set("caller_c", {
    id: "caller_c",
    label: "mainEntry()",
    file_type: "code",
    source_file: "src/index.ts",
    is_callable: true,
    is_class: false,
    raw_code: "export function mainEntry() { return funcA(10); }",
    estimated_tokens: 20,
    dependencies: ["cycle_a"],
    callers: []
  });

  const dag2 = condenseGraphWithTarjan(mockNodes);
  const cyclicComp = Array.from(dag2.components.values()).find((c) => c.isCyclic);
  if (!cyclicComp) throw new Error("Cyclic component not detected!");

  const { levels: levels2 } = computeBottomUpTopoLevels(dag2);
  const batches2 = packTopoLevelsIntoLLMBatches(levels2, { maxTokensPerBatch: 1000 });
  const sccBatch = batches2.find((b) => b.sccComponentIds.includes(cyclicComp.id));
  if (!sccBatch) throw new Error("SCC batch not found!");

  const containedNodeIds = sccBatch.items.map((i) => i.nodeId);
  const cycleKeptTogether = cyclicComp.nodeIds.every((id) => containedNodeIds.includes(id));
  if (!cycleKeptTogether) throw new Error("SCC cycle group was split across batches!");

  console.log(`✓ SUCCESS: SCC cycle group [${cyclicComp.nodeIds.join(", ")}] was kept strictly together in batch: ${sccBatch.batchId}`);
  console.log("\nALL ANALYZER TESTS PASSED! 🎉\n");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
