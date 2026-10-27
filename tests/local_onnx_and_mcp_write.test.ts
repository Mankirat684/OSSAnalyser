import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  LocalOnnxEmbeddingProvider,
  LocalHashEmbeddingProvider,
  getDefaultEmbeddingProvider
} from "../src/retrieval/embeddingProvider.js";
import { SQLiteStore } from "../src/storage/sqlite/sqliteStore.js";
import { createMcpServer } from "../src/mcp/server.js";

async function runTest() {
  console.log("==========================================================");
  console.log("  TEST: Local 768-d ONNX Embedding & Zero-Key MCP Write Tools");
  console.log("==========================================================");

  // 1. Test Default Provider Resolution (No API Key)
  delete process.env.GEMINI_API_KEY;
  const defaultProvider = getDefaultEmbeddingProvider();
  console.log(`✓ Default Embedding Provider: ${defaultProvider.name} (Model: ${defaultProvider.model})`);
  assert.strictEqual(defaultProvider.name, "local-onnx");
  assert.strictEqual(defaultProvider.dims, 768);

  // 2. Test Local ONNX Model Inference (768 dimensions)
  console.log("\n[Test 1] Generating 768-d ONNX neural embeddings...");
  const t0 = Date.now();
  const sampleTexts = [
    "class AuthenticationMiddleware: Handles HTTP authentication headers",
    "def route_request(path: str, method: str): Dispatches incoming HTTP requests"
  ];
  const [docVec, queryVec] = await Promise.all([
    defaultProvider.embed([sampleTexts[0]], "document"),
    defaultProvider.embed([sampleTexts[1]], "query")
  ]);

  console.log(`✓ Generated 2 vectors in ${Date.now() - t0}ms`);
  assert.strictEqual(docVec[0].length, 768, "Document vector must be 768 dimensions");
  assert.strictEqual(queryVec[0].length, 768, "Query vector must be 768 dimensions");

  // Verify L2 normalization: sum of squares ≈ 1.0
  let norm = 0;
  for (let i = 0; i < 768; i++) norm += docVec[0][i] * docVec[0][i];
  console.log(`✓ Vector L2 norm: ${norm.toFixed(4)} (expected ~1.0)`);
  assert.ok(Math.abs(norm - 1.0) < 0.01, "Vector must be L2 normalized");

  // 3. Test MCP Write Tools against SQLiteStore
  console.log("\n[Test 2] Testing zero-key agent backfill MCP tools in SQLite...");
  const testDbDir = path.join(process.cwd(), "tests", "fixtures", "onnx_mcp_test");
  if (!fs.existsSync(testDbDir)) fs.mkdirSync(testDbDir, { recursive: true });
  const testDbPath = path.join(testDbDir, "knowledge.db");
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const store = new SQLiteStore(testDbPath);
  await store.init();

  const repoId = "repo_test";
  await store.saveRepository({ id: repoId, name: "test_repo", rootPath: testDbDir });

  // Add dummy file and symbol
  const dummyFileNode = {
    id: "file_test_ts",
    repoId,
    nodeType: "file",
    name: "test.ts",
    filePath: "src/test.ts",
    summary: "pending_summary",
    summaryStatus: "missing" as const
  };
  const dummySymbolNode = {
    id: "fn_authenticate",
    repoId,
    nodeType: "function",
    name: "authenticate",
    filePath: "src/test.ts",
    signature: "function authenticate(req: Request): User",
    rawCode: "function authenticate(req: Request): User { return parseToken(req); }",
    summary: "pending_summary",
    summaryStatus: "missing" as const
  };
  await store.upsertNodes([dummyFileNode, dummySymbolNode]);

  // Create MCP Server
  const mcpServer = createMcpServer(store, testDbDir, repoId);

  // Tool: get_unsummarized_nodes
  const unsummarizedTool = (mcpServer as any)._registeredTools["get_unsummarized_nodes"];
  assert.ok(unsummarizedTool, "get_unsummarized_nodes tool must be registered");
  const unsummarizedRes = await unsummarizedTool.handler({ limit: 10 });
  const unsummarizedData = JSON.parse(unsummarizedRes.content[0].text);
  console.log(`✓ get_unsummarized_nodes returned ${unsummarizedData.data.totalPending} pending items`);
  assert.strictEqual(unsummarizedData.data.totalPending, 2);

  // Tool: save_symbol_summary
  const saveSymbolTool = (mcpServer as any)._registeredTools["save_symbol_summary"];
  assert.ok(saveSymbolTool, "save_symbol_summary tool must be registered");
  const saveRes = await saveSymbolTool.handler({
    id_or_name: "authenticate",
    summary: "Validates bearer token and returns authenticated user identity.",
    embed: true
  });
  const saveData = JSON.parse(saveRes.content[0].text);
  console.log(`✓ save_symbol_summary updated symbol: ${saveData.data.name}, embedded: ${saveData.data.vectorEmbedded}`);
  assert.strictEqual(saveData.data.success, true);
  assert.strictEqual(saveData.data.vectorEmbedded, true);

  // Verify DB state
  const updatedNode = await store.getNode("authenticate");
  assert.strictEqual(updatedNode?.summary, "Validates bearer token and returns authenticated user identity.");
  assert.strictEqual(updatedNode?.summaryStatus, "fresh");

  // Verify FTS5 search finds the new summary
  const ftsHits = await store.searchNodesFts("bearer token", 5);
  console.log(`✓ FTS5 search for 'bearer token' returned ${ftsHits.length} hit(s)`);
  assert.ok(ftsHits.length > 0, "FTS5 must find node via freshly saved summary");

  // Tool: save_file_contract
  const saveFileTool = (mcpServer as any)._registeredTools["save_file_contract"];
  assert.ok(saveFileTool, "save_file_contract tool must be registered");
  const fileRes = await saveFileTool.handler({
    path: "src/test.ts",
    summary: "Authentication service handling token parsing and verification."
  });
  const fileData = JSON.parse(fileRes.content[0].text);
  console.log(`✓ save_file_contract updated file: ${fileData.data.filePath}`);
  assert.strictEqual(fileData.data.success, true);

  await store.close();
  try {
    fs.unlinkSync(testDbPath);
    fs.rmdirSync(testDbDir);
  } catch {}

  console.log("\nALL LOCAL 768-D ONNX & ZERO-KEY MCP WRITE TESTS PASSED! 🎉\n");
}

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
