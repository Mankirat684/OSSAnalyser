import { GraphifyExtractor } from "../src/pipeline/extractors/graphify.js";
import * as path from "node:path";
import * as assert from "node:assert";

async function runGraphifyTest() {
  console.log("==========================================================");
  console.log("  TEST: Graphify Extractor Adapter");
  console.log("==========================================================");

  const extractor = new GraphifyExtractor();
  const version = await extractor.version();
  console.log("✓ Graphify CLI version:", version);

  assert.strictEqual(extractor.supports(".ts"), true);
  assert.strictEqual(extractor.supports(".py"), true);
  assert.strictEqual(extractor.supports(".go"), true);
  assert.strictEqual(extractor.supports(".rs"), true);
  console.log("✓ Language support checks passed");

  const repoRoot = path.resolve(process.cwd());
  const files = [
    "src/cli/commands/doctor.ts",
    "src/cli/commands/init.ts",
    "src/cli/commands/status.ts"
  ];

  console.log("\n[Test 1] Extracting CLI command symbols via Graphify Tree-sitter...");
  const result = await extractor.extract(files, { repoRoot });

  console.log(`✓ Graphify extracted ${result.symbols.length} symbol(s) and ${result.edges.length} edge(s)`);
  assert.ok(result.symbols.length > 0, "Expected at least 1 extracted symbol");

  const symbolNames = result.symbols.map((s) => s.name);
  console.log("Extracted symbol sample:", symbolNames.slice(0, 5));

  assert.ok(
    symbolNames.some((n) => n.includes("Doctor") || n.includes("Init") || n.includes("Status")),
    "Expected doctor/init/status command symbols to be extracted"
  );

  console.log("\nALL GRAPHIFY EXTRACTOR TESTS PASSED! 🎉\n");
}

runGraphifyTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
