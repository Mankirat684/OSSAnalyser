import * as path from "node:path";
import * as fs from "node:fs";
import { SQLiteStore } from "../../storage/sqlite/sqliteStore.js";

export interface StatusOptions {
  repo?: string;
  json?: boolean;
}

export async function runStatusCommand(options: StatusOptions): Promise<void> {
  const repoRoot = path.resolve(options.repo || process.cwd());
  const ossDir = path.join(repoRoot, ".oss-analyser");
  const dbPath = path.join(ossDir, "knowledge.db");

  if (!fs.existsSync(dbPath)) {
    console.log(`No OSS Analyser knowledge database found in ${repoRoot}.`);
    console.log(`Run 'oss-analyser init' to set up.`);
    return;
  }

  const dbStat = fs.statSync(dbPath);
  const store = new SQLiteStore(dbPath);
  await store.init();

  const commit = await store.getMeta("last_indexed_commit");
  const dirty = await store.getMeta("last_indexed_dirty");
  const indexedAt = await store.getMeta("last_indexed_at");

  const repoName = path.basename(repoRoot);
  const repoId = `repo_${repoName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  const allNodes = await store.getAllNodes(repoId);

  const symbols = allNodes.filter((n) => n.nodeType === "function" || n.nodeType === "method" || n.nodeType === "class");
  const files = allNodes.filter((n) => n.nodeType === "file");

  const summaryCoverage = {
    missing: symbols.filter((s) => s.summaryStatus === "missing").length,
    fresh: symbols.filter((s) => s.summaryStatus === "fresh").length,
    stale: symbols.filter((s) => s.summaryStatus === "stale").length,
    possibly_stale: symbols.filter((s) => s.summaryStatus === "possibly_stale").length,
    heuristic: symbols.filter((s) => s.summaryStatus === "heuristic").length
  };

  const coveragePct = symbols.length > 0 ? Math.round(((symbols.length - summaryCoverage.missing) / symbols.length) * 100) : 0;
  const unresolved = await store.getUnresolvedRefs(repoId);
  const vecCount = store.getVecCount();
  const vecAvailable = store.isVecAvailable();

  await store.close();

  const statusReport = {
    repository: repoRoot,
    lastIndexedCommit: commit || "unknown",
    workingTreeDirty: dirty === "true",
    lastIndexedAt: indexedAt,
    databaseSizeKb: Math.round(dbStat.size / 1024),
    filesCount: files.length,
    symbolsCount: symbols.length,
    vectorCount: vecCount,
    unresolvedCount: unresolved.length,
    summaryCoveragePct: coveragePct,
    summaryBreakdown: summaryCoverage
  };

  if (options.json) {
    console.log(JSON.stringify(statusReport, null, 2));
    return;
  }

  console.log(`\n==========================================================`);
  console.log(`  OSS Analyser: Knowledge Base Status`);
  console.log(`==========================================================`);
  console.log(`Repository Root   : ${repoRoot}`);
  console.log(`Last Indexed Commit: ${commit || "none"} ${dirty === "true" ? "(DIRTY)" : "(CLEAN)"}`);
  console.log(`Last Indexed At   : ${indexedAt || "never"}`);
  console.log(`Database Size     : ${(dbStat.size / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`Indexed Files     : ${files.length}`);
  console.log(`Indexed Symbols   : ${symbols.length}`);
  console.log(`Vector Embeddings : ${vecCount} vectors ${vecAvailable ? "(sqlite-vec persistent ANN)" : "(disabled)"}`);
  console.log(`Unresolved Calls  : ${unresolved.length}`);
  console.log(`Summary Coverage  : ${coveragePct}%`);
  console.log(`  • Missing       : ${summaryCoverage.missing}`);
  console.log(`  • Fresh         : ${summaryCoverage.fresh}`);
  console.log(`  • Stale         : ${summaryCoverage.stale}`);
  console.log(`  • Possibly Stale: ${summaryCoverage.possibly_stale}`);
  console.log(`  • Heuristic     : ${summaryCoverage.heuristic}`);
  console.log(`==========================================================\n`);
}
