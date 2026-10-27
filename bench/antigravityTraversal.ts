import * as path from "node:path";
import * as fs from "node:fs";
import { SQLiteStore } from "../src/storage/sqlite/sqliteStore.js";
import { estimateTokens } from "../src/mcp/envelope.js";

async function runAntigravityTraversalSimulation() {
  const repoRoot = path.resolve(process.cwd(), "bench_repos", "zustand");
  const dbPath = path.join(repoRoot, ".oss-analyser", "knowledge.db");
  const repoId = "repo_zustand";

  const store = new SQLiteStore(dbPath);
  await store.init();

  console.log("==========================================================");
  console.log("  SCRIPTED UPPER-BOUND TRAVERSAL SIMULATION");
  console.log("==========================================================");
  console.log("Task        : Discover how Zustand stores state and what breaks if createStore changes.");
  console.log("Methodology : Theoretical lower bound assuming optimal 4-step path without detours,");
  console.log("              failed searches, or secondary raw-source verification reads.\n");

  const turnTokens: number[] = [];

  // Turn 1: Inspect module structure
  const allNodes = await store.getAllNodes(repoId);
  const srcFiles = allNodes.filter(n => n.nodeType === "file" && n.filePath.startsWith("src/"));
  const turn1Payload = {
    module: "src",
    total: srcFiles.length,
    files: srcFiles.slice(0, 10).map(f => ({ filePath: f.filePath, summary: f.summary }))
  };
  const t1 = estimateTokens(JSON.stringify(turn1Payload, null, 2));
  turnTokens.push(t1);
  console.log(`[Turn 1: get_module_summary("src")]`);
  console.log(`  Payload: ${t1} tokens (${srcFiles.length} files discovered)`);

  // Turn 2: Inspect src/vanilla.ts contract
  const vanillaNodes = await store.getNodesByFilePath("src/vanilla.ts");
  const turn2Payload = {
    file: "src/vanilla.ts",
    symbols: vanillaNodes.map(n => ({
      name: n.name,
      nodeType: n.nodeType,
      signature: n.signature,
      startLine: n.startLine,
      endLine: n.endLine
    }))
  };
  const t2 = estimateTokens(JSON.stringify(turn2Payload, null, 2));
  turnTokens.push(t2);
  console.log(`[Turn 2: get_file_contract("src/vanilla.ts")]`);
  console.log(`  Payload: ${t2} tokens (${vanillaNodes.length} symbols in vanilla.ts)`);

  // Turn 3: Get symbol details for createStore
  const sym = await store.getNode("createStore");
  const callers = sym ? await store.getCallers(sym.id, 1, true) : [];
  const turn3Payload = {
    symbol: sym?.name,
    filePath: sym?.filePath,
    signature: sym?.signature,
    callers: callers.map(c => ({ name: c.name, file: c.filePath, relation: c.relation }))
  };
  const t3 = estimateTokens(JSON.stringify(turn3Payload, null, 2));
  turnTokens.push(t3);
  console.log(`[Turn 3: get_symbol("createStore")]`);
  console.log(`  Payload: ${t3} tokens (${callers.length} direct callers found)`);

  // Turn 4: Get transitive blast radius for createStore
  const blast = sym ? await store.getBlastRadius(sym.id, 3, true) : [];
  const turn4Payload = {
    target: "createStore",
    affectedCount: blast.length,
    affectedSymbols: blast.map(b => ({ name: b.name, file: b.filePath, depth: b.depth }))
  };
  const t4 = estimateTokens(JSON.stringify(turn4Payload, null, 2));
  turnTokens.push(t4);
  console.log(`[Turn 4: get_blast_radius("createStore", depth=3)]`);
  console.log(`  Payload: ${t4} tokens (${blast.length} transitive callers mapped)`);

  const totalTraversalTokens = turnTokens.reduce((a, b) => a + b, 0);

  // Raw files that would otherwise have been read:
  const rawFilesToRead = [
    "bench_repos/zustand/src/vanilla.ts",
    "bench_repos/zustand/src/react.ts",
    "bench_repos/zustand/src/traditional.ts",
    "bench_repos/zustand/src/middleware/persist.ts",
    "bench_repos/zustand/src/middleware/devtools.ts"
  ];
  let rawContent = "";
  for (const f of rawFilesToRead) {
    if (fs.existsSync(f)) rawContent += fs.readFileSync(f, "utf-8") + "\n";
  }
  const rawFileTokens = estimateTokens(rawContent);

  console.log("\n----------------------------------------------------------");
  console.log("MULTI-TURN HARNESS SUMMARY:");
  console.log(`  • Multi-Turn Traversal Tokens : ${totalTraversalTokens.toLocaleString()} tokens across 4 turns`);
  console.log(`  • Equivalent Raw Files Tokens : ${rawFileTokens.toLocaleString()} tokens (5 files)`);
  console.log(`  • Net Context Savings         : ${Math.round(((rawFileTokens - totalTraversalTokens) / rawFileTokens) * 100)}%`);
  console.log("----------------------------------------------------------\n");
}

runAntigravityTraversalSimulation().catch(console.error);
