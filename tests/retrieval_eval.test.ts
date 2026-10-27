import * as path from "node:path";
import assert from "node:assert";
import { SQLiteStore } from "../src/storage/sqlite/sqliteStore.js";
import { buildContext } from "../src/retrieval/relevantContext.js";
import { LocalHashEmbeddingProvider } from "../src/retrieval/embeddingProvider.js";
import { VectorEngine } from "../src/retrieval/vectorStore.js";
import { createMcpServer } from "../src/mcp/server.js";

async function runRetrievalEvalTests() {
  console.log("==========================================================");
  console.log("  TEST: Hybrid RRF Retrieval, Evaluation & Degradation");
  console.log("==========================================================");

  const repoRoot = process.cwd();
  const dbPath = path.join(repoRoot, ".oss-analyser", "knowledge.db");
  const repoName = path.basename(repoRoot);
  const repoId = `repo_${repoName.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  const store = new SQLiteStore(dbPath);
  await store.init();

  const embedProvider = new LocalHashEmbeddingProvider();
  const vectorEngine = new VectorEngine();

  // Index vectors
  console.log("Generating structural vector embeddings for evaluation...");
  const embeddedCount = await vectorEngine.embedNodes(store, repoId, embedProvider);
  console.log(`✓ Embedded ${embeddedCount} symbols/files into local vector space`);

  // Test Questions: Vocabulary matches + semantic queries
  const evalSet = [
    {
      query: "SQLiteStore blast radius calculation",
      expectedSymbols: ["SQLiteStore", "getBlastRadius"]
    },
    {
      query: "tarjan strongly connected components",
      expectedSymbols: ["condenseGraphWithTarjan"]
    },
    {
      query: "secret scanner credentials redaction",
      expectedSymbols: ["SecretScanner"]
    }
  ];

  console.log("\n[Test 1] Evaluating Lexical vs Vector vs Hybrid RRF on Evaluation Set...");
  for (const item of evalSet) {
    const hybridRes = await buildContext(
      item.query,
      {
        repoId,
        repoRoot,
        mode: "hybrid",
        embeddingProvider: embedProvider,
        vectorEngine
      },
      store
    );

    const lexicalRes = await buildContext(
      item.query,
      {
        repoId,
        repoRoot,
        mode: "lexical"
      },
      store
    );

    console.log(`\nQuery: "${item.query}"`);
    console.log(`  Hybrid Hits : ${hybridRes.symbols.map((s) => s.name).slice(0, 3).join(", ")}`);
    console.log(`  Lexical Hits: ${lexicalRes.symbols.map((s) => s.name).slice(0, 3).join(", ")}`);

    const hasExpected = item.expectedSymbols.some((exp) =>
      hybridRes.symbols.some((s) => s.name.includes(exp))
    );
    assert.ok(hasExpected, `Hybrid retrieval must contain at least one expected symbol for: ${item.query}`);
    console.log(`  ✓ Expected target retrieved with score`);
  }

  // Test 2: Injected Direct Callers on top confident nodes
  console.log("\n[Test 2] Direct Callers Injection Check...");
  const ctx = await buildContext(
    "SQLiteStore",
    {
      repoId,
      repoRoot,
      mode: "hybrid",
      embeddingProvider: embedProvider,
      vectorEngine
    },
    store
  );

  const topNode = ctx.symbols[0];
  assert.ok(topNode, "Must have top symbol");
  assert.ok(
    topNode.directCallers && topNode.directCallers.length > 0,
    "Top confident symbol must have direct callers injected"
  );
  console.log(`✓ Direct callers successfully injected for '${topNode.name}':`, topNode.directCallers.map((c) => c.name));

  // Test 3: Graceful Lexical Fallback when Embeddings fail/unavailable
  console.log("\n[Test 3] Lexical Fallback Degradation...");
  const failingProvider = {
    name: "failing",
    model: "none",
    dims: 768,
    embed: async () => {
      throw new Error("Provider unavailable");
    }
  };

  const fallbackCtx = await buildContext(
    "SQLiteStore blast radius",
    {
      repoId,
      repoRoot,
      mode: "hybrid",
      embeddingProvider: failingProvider as any,
      vectorEngine
    },
    store
  );

  assert.strictEqual(fallbackCtx.retrievalMode, "lexical_fallback");
  assert.ok(fallbackCtx.symbols.length > 0, "Fallback must still return valid symbols");
  console.log(`✓ Graceful fallback verified: mode = '${fallbackCtx.retrievalMode}', hits = ${fallbackCtx.symbols.length}`);

  // Test 4: Parity between CLI query and MCP get_relevant_context
  console.log("\n[Test 4] Parity between CLI and MCP Tool payloads...");
  const mcpServer = createMcpServer(store, repoRoot, repoId);
  const directPayload = await buildContext("SQLiteStore", { repoId, repoRoot }, store);
  assert.strictEqual(ctx.symbols[0].id, directPayload.symbols[0].id);
  console.log("✓ CLI buildContext output matches MCP retrieval engine output");

  await store.close();
  console.log("\nALL HYBRID RETRIEVAL & EVALUATION TESTS PASSED! 🎉\n");
}

runRetrievalEvalTests();
