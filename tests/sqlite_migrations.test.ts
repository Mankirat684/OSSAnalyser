import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { runMigrations, resolveMigrationsDir } from "../src/storage/sqlite/migrator.js";
import { SQLiteStore } from "../src/storage/sqlite/sqliteStore.js";

async function runMigrationTests() {
  console.log("==========================================================");
  console.log("  TEST: SQLite Schema Migration Runner (PRAGMA user_version)");
  console.log("==========================================================");

  const migrationsDir = resolveMigrationsDir();
  console.log(`✓ Resolved migrations directory: ${migrationsDir}`);
  assert.ok(fs.existsSync(migrationsDir), "Migrations directory must exist");

  // [Test 1] Fresh database migration
  console.log("\n[Test 1] Initializing fresh in-memory database...");
  const db = new Database(":memory:");
  const initialVer = db.pragma("user_version", { simple: true }) as number;
  assert.strictEqual(initialVer, 0, "New DB should have user_version = 0");

  const result = runMigrations(db);
  console.log(`✓ Applied ${result.applied.length} migration(s):`, result.applied.map((m) => m.name));
  assert.ok(result.applied.length > 0, "Should apply at least 001_initial.sql");

  const newVer = db.pragma("user_version", { simple: true }) as number;
  console.log(`✓ Resulting user_version: ${newVer}`);
  assert.strictEqual(newVer, 1, "user_version should be 1 after initial migration");

  // Verify tables were created
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  const tableNames = tables.map((t) => t.name);
  console.log("Created tables sample:", tableNames.slice(0, 5));
  assert.ok(tableNames.includes("code_nodes"), "code_nodes table must exist");
  assert.ok(tableNames.includes("code_edges"), "code_edges table must exist");
  assert.ok(tableNames.includes("repositories"), "repositories table must exist");

  // [Test 2] Idempotency: Running migrations again should apply 0 migrations
  console.log("\n[Test 2] Testing idempotency (no-op on up-to-date DB)...");
  const secondRun = runMigrations(db);
  console.log(`✓ Second run applied ${secondRun.applied.length} migration(s)`);
  assert.strictEqual(secondRun.applied.length, 0, "Second run should apply zero migrations");
  assert.strictEqual(secondRun.currentVersion, 1, "Version should remain unchanged");

  db.close();

  // [Test 3] SQLiteStore integration
  console.log("\n[Test 3] Testing SQLiteStore.init() migration invocation...");
  const tempDbPath = path.join(process.cwd(), ".oss-analyser", "test_migrator.db");
  if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);

  const store = new SQLiteStore(tempDbPath);
  await store.init();
  const storeVer = store.getSchemaVersion();
  console.log(`✓ SQLiteStore schema version: v${storeVer}`);
  assert.strictEqual(storeVer, 1, "SQLiteStore must be at version 1");
  await store.close();

  if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);

  console.log("\nALL SQLITE MIGRATION TESTS PASSED! 🎉\n");
}

runMigrationTests().catch((err) => {
  console.error("Migration test failed:", err);
  process.exit(1);
});
