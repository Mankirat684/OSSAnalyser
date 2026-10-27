import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import assert from "node:assert";
import { SQLiteStore } from "../src/storage/sqlite/sqliteStore.js";
import { runIndexingPipeline } from "../src/pipeline/indexPipeline.js";

async function runIncrementalTests() {
  console.log("==========================================================");
  console.log("  TEST: Incremental Indexing, Stable IDs & Cascade Safety");
  console.log("==========================================================");

  // Setup sandbox fixture repo in tmp/fixture_test_repo
  const fixtureDir = path.join(process.cwd(), "tmp", "fixture_test_repo");
  if (fs.existsSync(fixtureDir)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fileA = path.join(fixtureDir, "a.ts");
  const fileB = path.join(fixtureDir, "b.ts");
  const fileC = path.join(fixtureDir, "c.ts");

  // a.ts and b.ts form a mutual cycle: fromA calls fromB, fromB calls fromA
  // c.ts calls fromA
  fs.writeFileSync(
    fileA,
    `import { fromB } from "./b";\nexport function fromA(): string {\n  const res = fromB();\n  return "A" + res;\n}\n`,
    "utf-8"
  );
  fs.writeFileSync(
    fileB,
    `import { fromA } from "./a";\nexport function fromB(): string {\n  const res = fromA();\n  return "B" + res;\n}\n`,
    "utf-8"
  );
  fs.writeFileSync(
    fileC,
    `import { fromA } from "./a";\nexport function callerC(): void {\n  const val = fromA();\n  console.log(val);\n}\n`,
    "utf-8"
  );

  const dbPath = path.join(fixtureDir, ".oss-analyser", "knowledge.db");
  const store = new SQLiteStore(dbPath);
  await store.init();

  // Test 1: Initial Index Run
  console.log("\n[Test 1] Initial Index Run...");
  const stats1 = await runIndexingPipeline(store, { repoRoot: fixtureDir, noBlame: true });
  assert.strictEqual(stats1.filesScanned, 3);
  assert.strictEqual(stats1.filesChanged, 3);
  console.log(`✓ Scanned ${stats1.filesScanned} files, extracted ${stats1.totalSymbols} symbols`);

  // Verify SCC cycle detection: fromA and fromB should share sccId
  const repoId = "repo_fixture_test_repo";
  const nodeA = await store.getNode("fromA");
  const nodeB = await store.getNode("fromB");
  const nodeC = await store.getNode("callerC");

  assert.ok(nodeA, "nodeA should exist");
  assert.ok(nodeB, "nodeB should exist");
  assert.ok(nodeC, "nodeC should exist");

  console.log(`Node fromA ID: ${nodeA.id}, sccId: ${nodeA.sccId}`);
  console.log(`Node fromB ID: ${nodeB.id}, sccId: ${nodeB.sccId}`);
  console.log(`Node callerC ID: ${nodeC.id}, sccId: ${nodeC.sccId}`);

  assert.ok(nodeA.sccId != null, "fromA should belong to an SCC cycle");
  assert.strictEqual(nodeA.sccId, nodeB.sccId, "fromA and fromB must share the same sccId");
  assert.strictEqual(nodeC.sccId, null, "callerC is not in a cycle, sccId should be null");
  console.log("✓ Mutual cycle (fromA <-> fromB) correctly condensed into shared SCC component");

  // Test 2: Re-running Index with zero changes
  console.log("\n[Test 2] Zero-parsing Incremental Verification...");
  const stats2 = await runIndexingPipeline(store, { repoRoot: fixtureDir, noBlame: true });
  assert.strictEqual(stats2.filesChanged, 0, "Unchanged files should perform 0 re-extractions");
  console.log("✓ Verified 0 re-extractions on unchanged workspace");

  // Test 3: Sampled check confirms symbol coordinates match source text hash
  console.log("\n[Test 3] Sampled coordinate & hash fidelity check...");
  const rawFileA = fs.readFileSync(fileA, "utf-8");
  const linesA = rawFileA.split(/\r?\n/);
  const slicedA = linesA.slice(nodeA.startLine! - 1, nodeA.endLine!).join("\n");
  const hashOfSliceA = crypto.createHash("sha256").update(slicedA).digest("hex");
  assert.strictEqual(hashOfSliceA, nodeA.sourceHash, "Stored source_hash must match text at coordinates");
  console.log("✓ Stored source_hash matches exact source text slice at coordinate range");

  // Test 4: Editing one file (a.ts)
  console.log("\n[Test 4] Edit a.ts and test stable IDs & cascade safety...");
  // Simulate an existing summary on fromA, fromB, and callerC
  await store.updateSummaryStatus(nodeA.id, "fresh", { summary: "Summary of fromA" });
  await store.updateSummaryStatus(nodeB.id, "fresh", { summary: "Summary of fromB" });
  await store.updateSummaryStatus(nodeC.id, "fresh", { summary: "Summary of callerC" });

  // Add 3 blank lines at the top of a.ts and modify code inside fromA
  fs.writeFileSync(
    fileA,
    `\n\n\nimport { fromB } from "./b";\n// Line shift comment\nexport function fromA(): string {\n  const res = fromB();\n  return "MODIFIED_A" + res;\n}\n`,
    "utf-8"
  );

  const stats3 = await runIndexingPipeline(store, { repoRoot: fixtureDir, noBlame: true });
  assert.strictEqual(stats3.filesChanged, 1, "Only a.ts should be re-extracted");
  console.log("✓ Exactly 1 file (a.ts) re-extracted");

  // Check ID stability: fromA and fromB IDs must be unchanged
  const nodeA_v2 = await store.getNode("fromA");
  const nodeB_v2 = await store.getNode("fromB");
  const nodeC_v2 = await store.getNode("callerC");

  assert.strictEqual(nodeA_v2?.id, nodeA.id, "Stable ID: fromA ID must remain identical despite line shift");
  assert.strictEqual(nodeB_v2?.id, nodeB.id, "Stable ID: fromB ID must remain identical");
  assert.strictEqual(nodeC_v2?.id, nodeC.id, "Stable ID: callerC ID must remain identical");
  console.log("✓ Stable 12-char SHA-1 node IDs preserved across edits and line shifts");

  // Check Cascade Safety: fromB summary and incoming edge from c.ts must survive!
  assert.strictEqual(nodeB_v2?.summary, "Summary of fromB", "fromB summary must survive an edit to a.ts");
  const callersOfA = await store.getCallers(nodeA.id);
  const hasCallerC = callersOfA.some((c) => c.id === nodeC.id);
  assert.ok(hasCallerC, "Incoming edge from callerC to fromA must survive re-indexing of a.ts");
  console.log("✓ Cascade safety verified: Surviving nodes retain edges, summaries, and IDs");

  // Check Invalidation: fromA should be 'stale' and callerC should be 'possibly_stale'
  console.log(`fromA summaryStatus: ${nodeA_v2?.summaryStatus}`);
  console.log(`callerC summaryStatus: ${nodeC_v2?.summaryStatus}`);
  assert.strictEqual(nodeA_v2?.summaryStatus, "stale", "Modified symbol fromA must be marked 'stale'");
  assert.strictEqual(nodeC_v2?.summaryStatus, "possibly_stale", "Direct caller callerC must be marked 'possibly_stale'");
  console.log("✓ Invalidation rules verified: Leaf marked 'stale', direct caller marked 'possibly_stale'");

  // Cleanup
  await store.close();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  console.log("\nALL INCREMENTAL & CASCADE SAFETY TESTS PASSED! 🎉\n");
}

runIncrementalTests();
