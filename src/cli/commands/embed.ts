import * as path from "node:path";
import * as fs from "node:fs";
import { SQLiteStore } from "../../storage/sqlite/sqliteStore.js";
import { VectorEngine } from "../../retrieval/vectorStore.js";
import {
  LocalOnnxEmbeddingProvider,
  GeminiEmbeddingProvider,
  LocalHashEmbeddingProvider,
  type EmbeddingProvider
} from "../../retrieval/embeddingProvider.js";

export interface EmbedCommandOptions {
  repo?: string;
  provider?: "local" | "onnx" | "gemini" | "hash" | string;
  model?: string;
  force?: boolean;
  json?: boolean;
}

export async function runEmbedCommand(options: EmbedCommandOptions): Promise<void> {
  const repoRoot = path.resolve(options.repo || process.cwd());
  const dbPath = path.join(repoRoot, ".oss-analyser", "knowledge.db");

  if (!fs.existsSync(dbPath)) {
    console.error(`Knowledge database not found at ${dbPath}. Run 'oss-analyser init' and 'oss-analyser index' first.`);
    process.exit(1);
  }

  const store = new SQLiteStore(dbPath);
  await store.init();

  const repoName = path.basename(repoRoot);
  const firstRepo = await store.getFirstRepository();
  const repoId = firstRepo?.id || `repo_${repoName.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  const providerType = (options.provider || "local").toLowerCase();
  let provider: EmbeddingProvider;

  if (providerType === "gemini") {
    provider = new GeminiEmbeddingProvider();
  } else if (providerType === "hash") {
    provider = new LocalHashEmbeddingProvider();
  } else {
    // "local" or "onnx" (default)
    provider = new LocalOnnxEmbeddingProvider(options.model);
  }

  if (!options.json) {
    console.log(`\n==========================================================`);
    console.log(`  OSS Analyser: Vector Embedding Engine`);
    console.log(`==========================================================`);
    console.log(`Target Repository : ${repoRoot}`);
    console.log(`Database          : ${dbPath}`);
    console.log(`Provider          : ${provider.name}`);
    console.log(`Model             : ${provider.model} (${provider.dims} dimensions)`);
    console.log(`Force Rebuild     : ${options.force ? "Yes" : "No"}`);
    if (store.isVecAvailable()) {
      console.log(`Vector Store      : sqlite-vec persistent virtual table (vec_nodes)`);
    } else {
      console.warn(`Vector Store      : In-memory fallback (sqlite-vec extension not available)`);
    }
    console.log(`\nGenerating embeddings for code symbols and contracts...`);
  }

  const engine = new VectorEngine();
  const startTime = Date.now();
  const embeddedCount = await engine.embedNodes(store, repoId, provider, options.force);
  const durationMs = Date.now() - startTime;

  const persistentCount = store.getVecCount();

  await store.close();

  const resultStats = {
    repoId,
    provider: provider.name,
    model: provider.model,
    dims: provider.dims,
    nodesEmbedded: embeddedCount,
    persistentVectors: persistentCount,
    durationMs
  };

  if (options.json) {
    console.log(JSON.stringify(resultStats, null, 2));
    return;
  }

  console.log(`\n✓ Embedding Generation Complete in ${(durationMs / 1000).toFixed(2)}s`);
  console.log(`----------------------------------------------------------`);
  console.log(`  • Nodes Embedded   : ${embeddedCount}`);
  console.log(`  • Stored in DB     : ${persistentCount} vectors in vec_nodes`);
  console.log(`  • Model Dimensions : ${provider.dims} float32`);
  console.log(`----------------------------------------------------------\n`);
}
