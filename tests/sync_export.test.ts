import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { SQLiteStore } from "../src/storage/sqlite/sqliteStore.js";
import { DumpSync } from "../src/sync/dumpSync.js";

async function runSyncTests() {
  console.log("==========================================================");
  console.log("  TEST: Knowledge Graph Export & Dump Round-Trip Sync");
  console.log("==========================================================");

  const localDb = path.join(process.cwd(), ".oss-analyser", "knowledge.db");
  assert.ok(fs.existsSync(localDb), "Local knowledge.db must exist for sync test");

  const sourceStore = new SQLiteStore(localDb);
  await sourceStore.init();

  const repoName = path.basename(process.cwd());
  const repoId = `repo_${repoName.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  const tempDump = path.join(process.cwd(), ".oss-analyser", "temp_test_dump.json");
  const tempTargetDb = path.join(process.cwd(), ".oss-analyser", "temp_synced_target.db");

  try {
    // 1. Export local DB to JSON dump
    console.log("\n[Test 1] Exporting local knowledge graph to portable JSON dump...");
    const exportStats = await DumpSync.exportToJson(sourceStore, repoId, tempDump);
    console.log(`✓ Exported ${exportStats.nodesCount} nodes, ${exportStats.edgesCount} edges (${(exportStats.sizeBytes / 1024).toFixed(1)} KB)`);
    assert.ok(exportStats.nodesCount > 0, "Expected >0 nodes exported");
    assert.ok(fs.existsSync(tempDump), "Dump file must exist");

    // 2. Import into a fresh target database
    console.log("\n[Test 2] Importing dump into an empty SQLite database...");
    if (fs.existsSync(tempTargetDb)) fs.unlinkSync(tempTargetDb);

    const targetStore = new SQLiteStore(tempTargetDb);
    await targetStore.init();

    const importStats = await DumpSync.importFromJson(targetStore, tempDump);
    console.log(`✓ Imported repo '${importStats.repoName}' with ${importStats.nodesImported} nodes, ${importStats.edgesImported} edges`);

    assert.strictEqual(importStats.nodesImported, exportStats.nodesCount, "Imported nodes count must match exported");
    assert.strictEqual(importStats.edgesImported, exportStats.edgesCount, "Imported edges count must match exported");

    // 3. Verify target database queryability
    const importedRepo = await targetStore.getRepository(repoId);
    assert.ok(importedRepo != null, "Imported repo record must exist");
    assert.strictEqual(importedRepo.name, repoName);

    const ftsResults = await targetStore.searchNodesFts("SQLiteStore", 5);
    console.log(`✓ Target DB FTS5 search returned ${ftsResults.length} hit(s) for 'SQLiteStore'`);
    assert.ok(ftsResults.length > 0, "Imported DB must be searchable via FTS5");

    await targetStore.close();

    console.log("\nALL KNOWLEDGE GRAPH EXPORT & SYNC TESTS PASSED! 🎉\n");
  } finally {
    await sourceStore.close();
    if (fs.existsSync(tempDump)) fs.unlinkSync(tempDump);
    if (fs.existsSync(tempTargetDb)) fs.unlinkSync(tempTargetDb);
  }
}

runSyncTests().catch((err) => {
  console.error("Sync test failed:", err);
  process.exit(1);
});
