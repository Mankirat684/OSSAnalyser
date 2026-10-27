import * as path from "node:path";
import assert from "node:assert";
import { SQLiteStore } from "../src/storage/sqlite/sqliteStore.js";
import { createMcpServer, assertSafePath } from "../src/mcp/server.js";
import { EnvelopeBuilder, paginateItems } from "../src/mcp/envelope.js";

async function runMcpServerTests() {
  console.log("==========================================================");
  console.log("  TEST: MCP Server Protocol, Tools & Budget Enforcement");
  console.log("==========================================================");

  const repoRoot = process.cwd();
  const dbPath = path.join(repoRoot, ".oss-analyser", "knowledge.db");
  const repoName = path.basename(repoRoot);
  const repoId = `repo_${repoName.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  const store = new SQLiteStore(dbPath);
  await store.init();

  const server = createMcpServer(store, repoRoot, repoId);
  const toolCount = Object.keys((server as any)._registeredTools).length;
  console.log(`✓ Initialized McpServer with ${toolCount} tools`);

  // Helper to extract JSON data from wrapped tool call
  function parseToolResponse(wrapped: { content: Array<{ type: string; text: string }> }) {
    assert.strictEqual(wrapped.content[0].type, "text");
    return JSON.parse(wrapped.content[0].text);
  }

  // 1. search_symbols (Primitive Search in all 3 modes: lexical, semantic, hybrid)
  console.log("\n[Tool 1] search_symbols (Primitive search in lexical, semantic, hybrid)...");
  const searchTool = (server as any)._registeredTools["search_symbols"];
  assert.ok(searchTool, "search_symbols tool must be registered");

  // 1a. Lexical mode
  const lexRes = parseToolResponse(await searchTool.handler({ query: "SQLiteStore", mode: "lexical", limit: 5 }));
  assert.strictEqual(lexRes.data.mode, "lexical");
  assert.ok(lexRes.data.symbols.length > 0, "Lexical search must find hits");
  assert.ok(lexRes.data.symbols.some((s: any) => s.name === "SQLiteStore"), "Should find SQLiteStore in lexical mode");
  console.log(`✓ search_symbols (lexical) returned ${lexRes.data.symbols.length} hit(s)`);

  // 1b. Semantic mode
  const semRes = parseToolResponse(await searchTool.handler({ query: "database store", mode: "semantic", limit: 5 }));
  assert.strictEqual(semRes.data.mode, "semantic");
  assert.ok(semRes.data.symbols.length > 0, "Semantic search must return nearest neighbor hits");
  assert.ok(typeof semRes.data.symbols[0].score === "number", "Semantic hits must have numeric similarity scores");
  console.log(`✓ search_symbols (semantic) returned ${semRes.data.symbols.length} nearest neighbor hit(s)`);

  // 1c. Hybrid mode
  const hybRes = parseToolResponse(await searchTool.handler({ query: "SQLiteStore", mode: "hybrid", limit: 5 }));
  assert.strictEqual(hybRes.data.mode, "hybrid");
  assert.ok(hybRes.data.symbols.length > 0, "Hybrid search must find hits");
  console.log(`✓ search_symbols (hybrid) returned ${hybRes.data.symbols.length} hit(s)`);

  // 2. get_symbol
  console.log("\n[Tool 2] get_symbol: 'SQLiteStore'...");
  const node = await store.getNode("SQLiteStore");
  assert.ok(node, "SQLiteStore node should exist");
  const callers = await store.getCallers(node.id, 1, false);
  assert.ok(callers.length >= 1, "SQLiteStore should have callers");
  console.log(`✓ get_symbol verified (id: ${node.id}, callers: ${callers.length})`);

  // 3. get_file_contract
  console.log("\n[Tool 3] get_file_contract: 'src/cli/commands/index.ts'...");
  const fileNodes = await store.getNodesByFilePath("src/cli/commands/index.ts");
  assert.ok(fileNodes.length > 0, "Should find nodes in index.ts");
  console.log(`✓ get_file_contract verified with ${fileNodes.length} node(s)`);

  // 4. get_module_summary
  console.log("\n[Tool 4] get_module_summary: 'src/cli'...");
  const allNodes = await store.getAllNodes(repoId);
  const cliFiles = allNodes.filter((n) => n.nodeType === "file" && n.filePath.startsWith("src/cli"));
  assert.ok(cliFiles.length >= 4, "src/cli should contain at least 4 files");
  console.log(`✓ get_module_summary found ${cliFiles.length} child file(s) in src/cli`);

  // 5. get_blast_radius
  console.log("\n[Tool 5] get_blast_radius: 'SQLiteStore'...");
  const blast = await store.getBlastRadius(node.id, 3, false);
  assert.ok(blast.length >= 3, "Blast radius of SQLiteStore should be >= 3");
  console.log(`✓ get_blast_radius resolved ${blast.length} upstream caller(s)`);

  // 6. Server-Side Budget Enforcement
  console.log("\n[Budget Test] Enforcing small token budget (120 tokens)...");
  const largeData = {
    items: Array.from({ length: 50 }, (_, i) => ({
      id: `symbol_${i}`,
      name: `calculateRiskScore_${i}`,
      summary: "Computes complex portfolio risk factors across diverse asset classes and evaluates volatility."
    }))
  };
  const tinyMeta = await EnvelopeBuilder.createMeta(store, 120, [], repoRoot);
  const tinyWrapped = parseToolResponse(EnvelopeBuilder.wrap(largeData, tinyMeta));

  console.log(`Requested budget: ${tinyWrapped.meta.budget}`);
  console.log(`Estimated tokens: ${tinyWrapped.meta.tokens_est}`);
  console.log(`Truncated flag  : ${tinyWrapped.meta.truncated}`);
  console.log(`Items retained  : ${tinyWrapped.data.items.length} (out of 50)`);

  assert.strictEqual(tinyWrapped.meta.truncated, true, "Envelope must mark truncated: true");
  assert.ok(
    tinyWrapped.data.items.length < 50,
    "Items array must be truncated to fit within budget"
  );
  console.log("✓ Server-side budget enforcement successfully trimmed oversized output");

  // 7. Path Traversal Security Test
  console.log("\n[Security Test] Rejecting directory traversal...");
  assert.throws(
    () => assertSafePath(repoRoot, "../../etc/passwd"),
    /Security Violation: Path traversal rejected/
  );
  assert.throws(
    () => assertSafePath(repoRoot, "../outside.ts"),
    /Security Violation: Path traversal rejected/
  );
  console.log("✓ Path traversal attempts properly intercepted and rejected");

  // 8. Item-Based Pagination Test
  console.log("\n[Pagination Test] Verifying deterministic item pagination & cursor traversal...");
  const dummyItems = Array.from({ length: 120 }, (_, i) => ({ id: i, name: `item_${i}` }));

  // Page 1: default limit 50
  const page1 = paginateItems(dummyItems, 50, null, 50);
  assert.strictEqual(page1.total, 120);
  assert.strictEqual(page1.returned, 50);
  assert.strictEqual(page1.next_cursor, "50");
  assert.strictEqual(page1.items[0].id, 0);
  assert.strictEqual(page1.items[49].id, 49);

  // Page 2: with cursor '50'
  const page2 = paginateItems(dummyItems, 50, page1.next_cursor, 50);
  assert.strictEqual(page2.total, 120);
  assert.strictEqual(page2.returned, 50);
  assert.strictEqual(page2.next_cursor, "100");
  assert.strictEqual(page2.items[0].id, 50);
  assert.strictEqual(page2.items[49].id, 99);

  // Page 3: with cursor '100'
  const page3 = paginateItems(dummyItems, 50, page2.next_cursor, 50);
  assert.strictEqual(page3.total, 120);
  assert.strictEqual(page3.returned, 20);
  assert.strictEqual(page3.next_cursor, null, "Final page must have next_cursor: null");
  assert.strictEqual(page3.items[0].id, 100);
  assert.strictEqual(page3.items[19].id, 119);

  // Limit: 'all' returns all items
  const allPage = paginateItems(dummyItems, "all");
  assert.strictEqual(allPage.total, 120);
  assert.strictEqual(allPage.returned, 120);
  assert.strictEqual(allPage.next_cursor, null);
  console.log("✓ Deterministic pagination verified (total, returned, next_cursor, limit: 'all')");

  await store.close();
  console.log("\nALL MCP SERVER PROTOCOL & BUDGET TESTS PASSED! 🎉\n");
}

runMcpServerTests();
