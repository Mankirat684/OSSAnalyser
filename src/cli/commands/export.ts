import * as path from "node:path";
import * as fs from "node:fs";
import { SQLiteStore } from "../../storage/sqlite/sqliteStore.js";
import { PostgresExporter } from "../../sync/postgresExporter.js";
import { DumpSync } from "../../sync/dumpSync.js";

export interface ExportCommandOptions {
  repo?: string;
  postgres?: boolean;
  url?: string;
  dump?: string;
  importDump?: string;
  json?: boolean;
}

export async function runExportCommand(options: ExportCommandOptions): Promise<void> {
  const repoRoot = path.resolve(options.repo || process.cwd());
  const repoName = path.basename(repoRoot);
  const repoId = `repo_${repoName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  const dbPath = path.join(repoRoot, ".oss-analyser", "knowledge.db");

  if (!fs.existsSync(dbPath) && !options.importDump) {
    throw new Error(`Local database not found at ${dbPath}. Please run 'oss-analyser init' and 'oss-analyser index' first.`);
  }

  const store = new SQLiteStore(dbPath);
  await store.init();

  try {
    // 1. Import from JSON dump
    if (options.importDump) {
      const dumpPath = path.resolve(options.importDump);
      console.log(`\nImporting knowledge graph from: ${dumpPath}...`);
      const importResult = await DumpSync.importFromJson(store, dumpPath);
      console.log(`✓ Successfully imported repository '${importResult.repoName}'`);
      console.log(`  • Nodes imported: ${importResult.nodesImported}`);
      console.log(`  • Edges imported: ${importResult.edgesImported}\n`);
      return;
    }

    // 2. Export to JSON dump file
    if (options.dump) {
      const outPath = path.resolve(options.dump);
      console.log(`\nExporting knowledge graph to portable JSON: ${outPath}...`);
      const dumpResult = await DumpSync.exportToJson(store, repoId, outPath);
      console.log(`✓ Exported ${dumpResult.nodesCount} nodes and ${dumpResult.edgesCount} edges`);
      console.log(`  • Archive size: ${(dumpResult.sizeBytes / 1024).toFixed(1)} KB\n`);
      return;
    }

    // 3. Export to PostgreSQL
    if (options.postgres || options.url) {
      const connStr = options.url || process.env.DATABASE_URL;
      if (!connStr) {
        throw new Error("No PostgreSQL connection URL provided. Set DATABASE_URL in environment or pass --url <connection_string>.");
      }

      const maskedUrl = connStr.replace(/:([^:@]+)@/, ":****@");
      console.log(`\n==========================================================`);
      console.log(`  OSS Analyser: SQLite -> PostgreSQL Knowledge Sync`);
      console.log(`==========================================================`);
      console.log(`Target Repo      : ${repoName} (${repoId})`);
      console.log(`Destination DB   : ${maskedUrl}\n`);
      console.log(`Connecting to PostgreSQL and synchronizing graph tables...`);

      const stats = await PostgresExporter.exportToPostgres(store, {
        connectionString: connStr,
        repoId
      });

      if (options.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log(`\n✓ Sync to PostgreSQL completed in ${(stats.durationMs / 1000).toFixed(2)}s!`);
      console.log(`----------------------------------------------------------`);
      console.log(`  • Repositories Synced : 1 (${stats.repoName})`);
      console.log(`  • Code Nodes Upserted : ${stats.nodesExported}`);
      console.log(`  • Code Edges Upserted : ${stats.edgesExported}`);
      console.log(`  • Git Ownership Rows  : ${stats.ownershipExported}`);
      console.log(`----------------------------------------------------------`);
      console.log(`The web dashboard at localhost:4000 can now explore this repo!\n`);
      return;
    }

    console.log("No export target specified. Use --postgres (or --url) to sync to PostgreSQL, or --dump <file.json> to export a JSON archive.");
  } finally {
    await store.close();
  }
}
