import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert";
import { SQLiteStore } from "../src/storage/sqlite/sqliteStore.js";

async function runStoreTests() {
  console.log("==========================================================");
  console.log("  TEST: SQLiteStore & Recursive CTE Blast Radius");
  console.log("==========================================================");

  const testDbDir = path.join(process.cwd(), "tmp");
  if (!fs.existsSync(testDbDir)) fs.mkdirSync(testDbDir, { recursive: true });
  const testDbPath = path.join(testDbDir, "test_store.db");
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const store = new SQLiteStore(testDbPath);
  await store.init();
  console.log("✓ SQLiteStore initialized with schema & FTS5");

  // 1. Repository
  await store.saveRepository({
    id: "repo_test",
    name: "test-repo",
    rootPath: "/mock/root",
    status: "parsed"
  });
  const repo = await store.getRepository("repo_test");
  assert.strictEqual(repo?.name, "test-repo");
  console.log("✓ Repository upsert and retrieval verified");

  // 2. Nodes
  await store.upsertNodes([
    {
      id: "node_leaf",
      repoId: "repo_test",
      nodeType: "function",
      name: "calculateRisk",
      filePath: "src/risk.ts",
      startLine: 10,
      endLine: 20,
      signature: "calculateRisk(level: number): number",
      summary: "Calculates the overall risk score based on volatility"
    },
    {
      id: "node_caller_1",
      repoId: "repo_test",
      nodeType: "function",
      name: "evaluatePortfolio",
      filePath: "src/portfolio.ts",
      startLine: 30,
      endLine: 45,
      signature: "evaluatePortfolio(id: string): void",
      summary: "Evaluates risk across all assets"
    },
    {
      id: "node_caller_2",
      repoId: "repo_test",
      nodeType: "function",
      name: "handleWebhook",
      filePath: "src/api.ts",
      startLine: 50,
      endLine: 70,
      signature: "handleWebhook(req: Request): Response",
      summary: "API endpoint handler that triggers portfolio risk assessment"
    }
  ]);
  console.log("✓ Nodes upserted and indexed in FTS5");

  // 3. FTS5 Search
  const ftsResults = await store.searchNodesFts("volatility");
  assert.ok(ftsResults.length > 0, "FTS5 query should find calculateRisk");
  assert.strictEqual(ftsResults[0].name, "calculateRisk");
  console.log("✓ FTS5 BM25 search verified for 'volatility'");

  // 4. Edges: handleWebhook -> evaluatePortfolio -> calculateRisk
  await store.upsertEdges([
    {
      repoId: "repo_test",
      sourceId: "node_caller_1",
      targetId: "node_leaf",
      relation: "calls",
      confidence: "EXTRACTED"
    },
    {
      repoId: "repo_test",
      sourceId: "node_caller_2",
      targetId: "node_caller_1",
      relation: "calls",
      confidence: "EXTRACTED"
    }
  ]);
  console.log("✓ Call edges inserted");

  // 5. Blast Radius: blast radius of calculateRisk should be evaluatePortfolio (depth 1) and handleWebhook (depth 2)
  const blast = await store.getBlastRadius("node_leaf", 5);
  console.log("Blast radius for calculateRisk:", blast);
  assert.strictEqual(blast.length, 2);
  assert.strictEqual(blast[0].id, "node_caller_1");
  assert.strictEqual(blast[0].depth, 1);
  assert.strictEqual(blast[1].id, "node_caller_2");
  assert.strictEqual(blast[1].depth, 2);
  console.log("✓ Recursive CTE Blast Radius successfully resolved transitive callers in depth order");

  // 6. Test Cycle in Blast Radius
  // Add a cycle: cycleA <-> cycleB, with callerC calling cycleA
  await store.upsertNodes([
    {
      id: "cycle_a",
      repoId: "repo_test",
      nodeType: "function",
      name: "fromA",
      filePath: "src/cycle.ts",
      sccId: 99
    },
    {
      id: "cycle_b",
      repoId: "repo_test",
      nodeType: "function",
      name: "fromB",
      filePath: "src/cycle.ts",
      sccId: 99
    },
    {
      id: "cycle_caller",
      repoId: "repo_test",
      nodeType: "function",
      name: "outerCaller",
      filePath: "src/cycle.ts"
    }
  ]);

  await store.upsertEdges([
    { repoId: "repo_test", sourceId: "cycle_a", targetId: "cycle_b", relation: "calls", confidence: "EXTRACTED" },
    { repoId: "repo_test", sourceId: "cycle_b", targetId: "cycle_a", relation: "calls", confidence: "EXTRACTED" },
    { repoId: "repo_test", sourceId: "cycle_caller", targetId: "cycle_a", relation: "calls", confidence: "EXTRACTED" }
  ]);

  const cycleBlast = await store.getBlastRadius("cycle_b", 5);
  console.log("Cycle blast radius for cycle_b:", cycleBlast);
  // outerCaller should be reached without infinite recursion!
  const callerHit = cycleBlast.find((b) => b.id === "cycle_caller");
  assert.ok(callerHit, "outerCaller should be found in blast radius of cycle_b");
  console.log("✓ Cycle handling verified: No infinite loops in recursive CTE");

  // 7. Cleanup
  await store.close();
  fs.unlinkSync(testDbPath);
  console.log("\nALL SQLITE STORE TESTS PASSED! 🎉\n");
}

runStoreTests();
