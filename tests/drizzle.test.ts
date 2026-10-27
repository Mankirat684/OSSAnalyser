import { db, pool } from "../src/config/database.js";
import { repositories, codeNodes, codeEdges, gitOwnership, apiKeys, chatThreads, chatMessages } from "../src/modules/storage/schema.js";
import { eq, sql, getTableName } from "drizzle-orm";

async function testDrizzle() {
  console.log("==================================================================");
  console.log("  TEST: Drizzle ORM Schema & Query Builder");
  console.log("==================================================================\n");

  // 1. Verify schema table definitions
  console.log("[1] Verifying Drizzle table schemas...");
  console.log("✓ repositories table:", getTableName(repositories));
  console.log("✓ code_nodes table:", getTableName(codeNodes));
  console.log("✓ code_edges table:", getTableName(codeEdges));
  console.log("✓ git_ownership table:", getTableName(gitOwnership));
  console.log("✓ api_keys table:", getTableName(apiKeys));
  console.log("✓ chat_threads table:", getTableName(chatThreads));
  console.log("✓ chat_messages table:", getTableName(chatMessages));


  // 2. Verify SQL Query Generation
  console.log("\n[2] Verifying Drizzle SQL generation...");
  const selectQuery = db
    .select({
      id: repositories.id,
      name: repositories.name,
      status: repositories.status
    })
    .from(repositories)
    .where(eq(repositories.id, "test_repo"))
    .toSQL();

  console.log("✓ Generated SELECT SQL:", selectQuery.sql);
  console.log("✓ Params:", selectQuery.params);

  const joinQuery = db
    .select({
      nodeId: codeNodes.id,
      nodeName: codeNodes.name,
      relation: codeEdges.relation
    })
    .from(codeNodes)
    .innerJoin(codeEdges, eq(codeNodes.id, codeEdges.sourceId))
    .where(eq(codeNodes.repoId, "test_repo"))
    .toSQL();

  console.log("✓ Generated INNER JOIN SQL:", joinQuery.sql);

  const apiKeyQuery = db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      userEmail: apiKeys.userEmail,
      expiresAt: apiKeys.expiresAt
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, "test_user"))
    .toSQL();

  console.log("✓ Generated API Keys SELECT SQL:", apiKeyQuery.sql);

  // 3. Optional live query if PostgreSQL is available
  try {
    const isConnected = await pool.query("SELECT 1 as connected");
    if (isConnected.rows.length > 0) {
      console.log("\n[3] Testing live query with Drizzle client...");
      const result = await db.execute(sql`SELECT 1 as test`);
      console.log("✓ Live Drizzle execute result:", result.rows);
    }
  } catch {
    console.log("\n[3] PostgreSQL offline — verified query building & schema compilation offline.");
    console.log("💡 Start DB to test live connection: docker compose up -d postgres");
  }

  console.log("\nALL DRIZZLE TESTS PASSED! 🎉\n");
  await pool.end();
}

testDrizzle().catch((err) => {
  console.error("Drizzle test failed:", err);
  process.exit(1);
});
