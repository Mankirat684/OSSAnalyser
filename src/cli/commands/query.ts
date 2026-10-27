import * as path from "node:path";
import * as fs from "node:fs";
import { SQLiteStore } from "../../storage/sqlite/sqliteStore.js";
import { buildContext } from "../../retrieval/relevantContext.js";
import { EnvelopeBuilder } from "../../mcp/envelope.js";

export interface QueryCommandOptions {
  repo?: string;
  maxTokens?: number;
  mode?: "hybrid" | "lexical" | "semantic";
  json?: boolean;
  debug?: boolean;
}

export async function runQueryCommand(task: string, options: QueryCommandOptions): Promise<void> {
  const repoRoot = path.resolve(options.repo || process.cwd());
  const dbPath = path.join(repoRoot, ".oss-analyser", "knowledge.db");

  if (!fs.existsSync(dbPath)) {
    console.error(`Knowledge database not found at ${dbPath}. Run 'oss-analyser init' and 'oss-analyser index' first.`);
    process.exit(1);
  }

  const repoName = path.basename(repoRoot);
  const repoId = `repo_${repoName.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  const store = new SQLiteStore(dbPath);
  await store.init();

  const maxTokens = options.maxTokens ? Number(options.maxTokens) : 2000;
  const contextPackage = await buildContext(
    task,
    {
      repoId,
      repoRoot,
      maxTokens,
      mode: options.mode
    },
    store
  );

  const meta = await EnvelopeBuilder.createMeta(
    store,
    maxTokens,
    contextPackage.suggestedNextTools,
    repoRoot
  );

  await store.close();

  const responseEnvelope = {
    data: contextPackage,
    meta
  };

  if (options.json) {
    console.log(JSON.stringify(responseEnvelope, null, 2));
    return;
  }

  console.log(`\n==========================================================`);
  console.log(`  OSS Analyser: Context Retrieval Package`);
  console.log(`==========================================================`);
  console.log(`Task Query       : "${task}"`);
  console.log(`Retrieval Mode   : ${contextPackage.retrievalMode}`);
  console.log(`Estimated Tokens : ${meta.tokens_est} / ${meta.budget}`);
  if (contextPackage.repoOverview) {
    console.log(`Repo Overview    : ${contextPackage.repoOverview}`);
  }
  console.log(`----------------------------------------------------------`);

  console.log(`\nTop Relevant Symbols (${contextPackage.symbols.length}):`);
  for (const s of contextPackage.symbols) {
    console.log(`  • ${s.name} (${s.sourcePointer}) [Score: ${s.score}]`);
    console.log(`    Why: ${s.why}`);
    if (s.summary) console.log(`    Summary: ${s.summary}`);
    if (s.directCallers && s.directCallers.length > 0) {
      console.log(`    Direct Callers: ${s.directCallers.map((c) => c.name).join(", ")}`);
    }
    console.log();
  }

  if (contextPackage.fileContracts.length > 0) {
    console.log(`Relevant File Contracts (${contextPackage.fileContracts.length}):`);
    for (const f of contextPackage.fileContracts) {
      console.log(`  • ${f.filePath} (${f.exportedSymbolsCount} exports) - ${f.summary}`);
    }
    console.log();
  }

  if (contextPackage.callGraphEdges.length > 0) {
    console.log(`Inter-symbol Call Graph:`);
    for (const e of contextPackage.callGraphEdges) {
      console.log(`  ↳ ${e.from} --[${e.relation}]--> ${e.to}`);
    }
    console.log();
  }

  console.log(`Suggested Next MCP Tools: ${contextPackage.suggestedNextTools.join(", ")}`);
  console.log(`==========================================================\n`);
}
