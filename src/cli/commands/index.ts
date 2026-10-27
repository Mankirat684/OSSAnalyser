import * as path from "node:path";
import * as fs from "node:fs";
import { SQLiteStore } from "../../storage/sqlite/sqliteStore.js";
import { runIndexingPipeline } from "../../pipeline/indexPipeline.js";

export interface CliIndexOptions {
  repo?: string;
  full?: boolean;
  noBlame?: boolean;
  json?: boolean;
  extractor?: "native" | "graphify";
}

export async function runIndexCommand(options: CliIndexOptions): Promise<void> {
  const repoRoot = path.resolve(options.repo || process.cwd());
  const ossDir = path.join(repoRoot, ".oss-analyser");
  const dbPath = path.join(ossDir, "knowledge.db");

  if (!fs.existsSync(dbPath)) {
    console.log(`Knowledge database not found at ${dbPath}. Initializing automatically...`);
    const { runInitCommand } = await import("./init.js");
    await runInitCommand({ repo: repoRoot });
  }

  const store = new SQLiteStore(dbPath);
  await store.init();

  if (!options.json) {
    console.log(`\n==========================================================`);
    console.log(`  OSS Analyser: Structural Codebase Indexer`);
    console.log(`==========================================================`);
    console.log(`Target Repository : ${repoRoot}`);
    console.log(`Extractor         : ${options.extractor || "native"}`);
    console.log(`Mode              : ${options.full ? "Full Rebuild" : "Incremental"}`);
    console.log(`Git Blame         : ${options.noBlame ? "Disabled" : "Enabled"}\n`);
    console.log(`Scanning workspace for AST symbols & dependencies...`);
  }

  const stats = await runIndexingPipeline(store, {
    repoRoot,
    full: options.full,
    noBlame: options.noBlame,
    extractor: options.extractor
  });

  await store.close();

  if (options.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log(`\n✓ Indexing Completed in ${(stats.durationMs / 1000).toFixed(2)}s`);
  console.log(`----------------------------------------------------------`);
  console.log(`  • Files Scanned    : ${stats.filesScanned} (${stats.filesChanged} re-extracted)`);
  console.log(`  • Extracted Symbols: ${stats.totalSymbols}`);
  console.log(`  • SCC Cycles Found : ${stats.sccCycles}`);
  console.log(`  • Unresolved Refs  : ${stats.unresolvedRefs}`);
  console.log(`----------------------------------------------------------\n`);
}
