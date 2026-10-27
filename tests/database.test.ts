import { RepositoryStore } from "../src/modules/storage/index.js";
import { pool } from "../src/config/database.js";

async function testDatabaseQueries() {
  console.log("==================================================================");
  console.log("  TEST: Blast Radius & Database Queries");
  console.log("==================================================================\n");

  // Test DB connection first
  try {
    await pool.query("SELECT 1");
  } catch (err: any) {
    console.log(`[Status] PostgreSQL is currently offline at ${pool.options.host || "localhost"}:${pool.options.port || 5432}.`);
    console.log("💡 Start PostgreSQL using: docker compose up -d postgres");
    console.log("💡 Or connect to Supabase by setting: DATABASE_URL=postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres");
    console.log("💡 And initialize schema using: npm run db:init\n");
    return;
  }

  const repoId = "repo_test_123";

  // 1. Node Details
  const nodeId = "src_services_userservice_userservice_describeuser";
  console.log(`[1] Fetching node details for: ${nodeId}...`);
  const details = await RepositoryStore.getNodeDetails(repoId, nodeId);

  if (!details) {
    throw new Error(`Node ${nodeId} not found in database! Ensure repo has been ingested.`);
  }

  console.log(`✓ Name: ${details.node.name} (${details.node.nodeType})`);
  console.log(`✓ Summary: ${details.node.summary}`);
  console.log(`✓ Callees: [${details.callees.map((c) => c.name).join(", ")}]`);

  // 2. Blast Radius (Recursive CTE)
  const targetLeafId = "src_repositories_userrepository_userrepository_findbyid";
  console.log(`\n[2] Computing BLAST RADIUS for: ${targetLeafId}...`);
  const blastRadius = await RepositoryStore.getBlastRadius(repoId, targetLeafId);

  console.log(`✓ Affected Upstream Functions/Methods (${blastRadius.length} found):`);
  for (const item of blastRadius) {
    console.log(`   💥 [Depth ${item.depth}] ${item.name} in ${item.filePath}`);
  }

  // 3. Web Graph Elements
  console.log(`\n[3] Fetching Web Graph Elements for repo: ${repoId}...`);
  const graph = await RepositoryStore.getGraphElements(repoId);
  console.log(`✓ Cytoscape Nodes: ${graph.nodes.length}`);
  console.log(`✓ Cytoscape Edges: ${graph.edges.length}`);

  console.log("\nALL DATABASE & BLAST RADIUS TESTS PASSED! 🎉\n");
  await pool.end();
}

testDatabaseQueries().catch((err) => {
  console.error("Database query test failed:", err);
  process.exit(1);
});
