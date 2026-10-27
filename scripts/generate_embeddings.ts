import * as path from "node:path";
import * as fs from "node:fs";
import { SQLiteStore } from "../src/storage/sqlite/sqliteStore.js";
import { VectorEngine } from "../src/retrieval/vectorStore.js";
import { LocalOnnxEmbeddingProvider } from "../src/retrieval/embeddingProvider.js";

async function main() {
  const targetRepo = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve("C:/Users/pvsra/kirat/benchmark/starlette-ossAnalyser");

  const dbPath = path.join(targetRepo, ".oss-analyser", "knowledge.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`Error: Knowledge database not found at ${dbPath}`);
    process.exit(1);
  }

  console.log(`==========================================================`);
  console.log(`  OSS Analyser: Local Embedding Generator`);
  console.log(`==========================================================`);
  console.log(`Target Repo : ${targetRepo}`);
  console.log(`Database    : ${dbPath}`);

  const store = new SQLiteStore(dbPath);
  await store.init();

  if (!store.isVecAvailable()) {
    console.warn(`Warning: sqlite-vec virtual extension not loaded! Embeddings will only be kept in-memory.`);
  } else {
    console.log(`✓ sqlite-vec loaded successfully. Virtual table vec_nodes ready.`);
  }

  const firstRepo = await store.getFirstRepository();
  const repoName = path.basename(targetRepo);
  const repoId = firstRepo?.id || `repo_${repoName.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  const provider = new LocalOnnxEmbeddingProvider();
  console.log(`Model       : ${provider.model} (${provider.dims} dimensions)`);
  console.log(`Engine      : Local CPU via @xenova/transformers (0 API calls, 0 cost)`);

  const engine = new VectorEngine();

  console.log(`\nScanning code nodes to embed...`);
  const startTime = Date.now();
  const count = await engine.embedNodes(store, repoId, provider, true);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Check rows in vec_nodes via public SQLiteStore method
  const persistedCount = store.getVecCount();

  console.log(`\n✓ Embedding Generation Complete!`);
  console.log(`  • Nodes Processed   : ${count}`);
  console.log(`  • Persistent Vectors : ${persistedCount} rows in vec_nodes`);
  console.log(`  • Total Duration    : ${duration}s`);
  console.log(`==========================================================\n`);

  await store.close();
}

main().catch((err) => {
  console.error("Embedding generation failed:", err);
  process.exit(1);
});
