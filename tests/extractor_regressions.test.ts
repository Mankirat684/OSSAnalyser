import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import { NativeExtractor } from "../src/pipeline/extractors/native.js";
import { GraphifyExtractor } from "../src/pipeline/extractors/graphify.js";
import { EdgeResolver } from "../src/pipeline/resolver.js";
import type { ExtractedSymbol, ExtractedEdge } from "../src/pipeline/extractor.js";

async function runRegressionTests() {
  console.log("==========================================================");
  console.log("  TEST: Extractor & Resolver Regressions (Fixtures)");
  console.log("==========================================================");

  const repoRoot = process.cwd();
  const fixturePath = "tests/fixtures/constructs_fixture.ts";

  // 1. NativeExtractor
  const nativeExtractor = new NativeExtractor();
  const nativeRes = await nativeExtractor.extract([fixturePath], { repoRoot });
  const nativeNames = nativeRes.symbols.map((s) => s.name);

  console.log("\n[Test 1] NativeExtractor on constructs fixture...");
  console.log("  Extracted symbols:", nativeNames);
  assert.ok(nativeNames.includes("createStore"), "NativeExtractor must extract cast declaration createStore");
  assert.ok(nativeNames.includes("createGenericPipeline"), "NativeExtractor must extract generic arrow createGenericPipeline");
  assert.ok(nativeNames.includes("handleAction"), "NativeExtractor must extract typed arrow handleAction");
  console.log("  ✓ All 3 TypeScript constructs extracted by NativeExtractor");

  // 2. EdgeResolver Candidate Disambiguation & Test Target/Source Rules
  console.log("\n[Test 2] EdgeResolver Disambiguation & Test Rules...");
  const symbols: ExtractedSymbol[] = [
    {
      id: "sym_lib_createStore",
      displayId: "src_store_ts_createStore_L10",
      name: "createStore",
      qualifiedName: "src/store.ts::createStore",
      nodeType: "function",
      filePath: "src/store.ts",
      startLine: 10,
      endLine: 25,
      signature: "createStore()",
      exported: true,
      sourceHash: "hash1"
    },
    {
      id: "sym_test_createStore_mock",
      displayId: "tests_mock_test_ts_createStore_L5",
      name: "createStore",
      qualifiedName: "tests/mock.test.ts::createStore",
      nodeType: "function",
      filePath: "tests/mock.test.ts",
      startLine: 5,
      endLine: 8,
      signature: "createStore()",
      exported: false,
      sourceHash: "hash2"
    },
    {
      id: "sym_src_app_run",
      displayId: "src_app_ts_run_L1",
      name: "run",
      qualifiedName: "src/app.ts::run",
      nodeType: "function",
      filePath: "src/app.ts",
      startLine: 1,
      endLine: 10,
      signature: "run()",
      exported: true,
      sourceHash: "hash3"
    },
    {
      id: "sym_test_suite_testApp",
      displayId: "tests_app_test_ts_testApp_L1",
      name: "testApp",
      qualifiedName: "tests/app.test.ts::testApp",
      nodeType: "function",
      filePath: "tests/app.test.ts",
      startLine: 1,
      endLine: 15,
      signature: "testApp()",
      exported: false,
      sourceHash: "hash4"
    }
  ];

  const rawEdges: ExtractedEdge[] = [
    // src/app.ts calls createStore (ambiguous: exists in src/store.ts and tests/mock.test.ts)
    {
      sourceId: "sym_src_app_run",
      targetName: "createStore",
      relation: "calls",
      confidence: "EXTRACTED",
      line: 5
    },
    // tests/app.test.ts calls createStore (test calling library function)
    {
      sourceId: "sym_test_suite_testApp",
      targetName: "createStore",
      relation: "calls",
      confidence: "EXTRACTED",
      line: 7
    }
  ];

  const resolver = new EdgeResolver();
  const resolveResult = resolver.resolve("test_repo", rawEdges, symbols);

  console.log("  Resolved Edges:", resolveResult.edges);
  console.log("  Unresolved:", resolveResult.unresolved);

  // Assertion A: src/app.ts resolved to src/store.ts (NOT test mock)
  const appEdge = resolveResult.edges.find((e) => e.sourceId === "sym_src_app_run");
  assert.ok(appEdge, "Edge from src/app.ts must be resolved");
  assert.strictEqual(appEdge?.targetId, "sym_lib_createStore", "Target must be library symbol, not test mock");
  assert.strictEqual(appEdge?.confidence, "INFERRED", "Disambiguated edge must have confidence INFERRED");

  // Assertion B: tests/app.test.ts caller is preserved as source!
  const testEdge = resolveResult.edges.find((e) => e.sourceId === "sym_test_suite_testApp");
  assert.ok(testEdge, "Edge originating from test file must be preserved as caller");
  assert.strictEqual(testEdge?.targetId, "sym_lib_createStore", "Test caller must resolve to library symbol");
  assert.strictEqual(testEdge?.confidence, "INFERRED", "Test-to-lib edge must have confidence INFERRED");

  console.log("  ✓ Test candidate exclusion verified (tests excluded as targets, retained as sources)");
  console.log("  ✓ Inferred confidence flag verified on all disambiguated edges");

  console.log("\nALL EXTRACTOR & RESOLVER REGRESSION TESTS PASSED! 🎉\n");
}

runRegressionTests().catch((err) => {
  console.error("Regression test failed:", err);
  process.exit(1);
});
