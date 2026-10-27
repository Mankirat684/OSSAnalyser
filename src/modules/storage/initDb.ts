import * as fs from "node:fs";
import * as path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../../config/database.js";

/**
 * Initializes database by ensuring vector extension and executing Drizzle migrations.
 * Guarantees schema.ts + drizzle/ migrations remain the single source of truth.
 */
export async function initializeDatabase(): Promise<void> {
  console.log("[DB] Connecting to PostgreSQL and synchronizing Drizzle migrations...");

  // 1. Ensure pgvector extension exists
  const client = await pool.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    client.release();
  }

  // 2. Locate Drizzle migrations directory
  const possiblePaths = [
    path.resolve(process.cwd(), "drizzle"),
    path.resolve(process.cwd(), "../drizzle"),
    path.resolve(process.cwd(), "dist/drizzle")
  ];
  const migrationsFolder = possiblePaths.find((p) => fs.existsSync(p)) || possiblePaths[0];

  // 3. Gracefully synchronize baseline if existing tables were initialized previously
  const syncClient = await pool.connect();
  try {
    await syncClient.query("CREATE SCHEMA IF NOT EXISTS drizzle;");
    await syncClient.query(`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      );
    `);

    const tableCheck = await syncClient.query(
      "SELECT to_regclass('public.repositories') as exists;"
    );
    const hasExistingTables = Boolean(tableCheck.rows[0]?.exists);

    const migrationCount = await syncClient.query(
      "SELECT count(*)::int as count FROM drizzle.__drizzle_migrations;"
    );

    if (hasExistingTables && migrationCount.rows[0].count === 0) {
      console.log("[DB] Existing database tables detected. Synchronizing baseline Drizzle migration entries...");
      await syncClient.query(`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES 
          ('init_baseline_0000', 1792507196706),
          ('init_baseline_0001', 1792672569660)
        ON CONFLICT DO NOTHING;
      `);
    }
  } finally {
    syncClient.release();
  }

  // 4. Run Drizzle migrations
  try {
    await migrate(db, { migrationsFolder });
    console.log("✓ PostgreSQL schema and Drizzle migrations synchronized successfully!");
  } catch (err: unknown) {
    console.error("[DB] Failed to synchronize Drizzle migrations:", err);
    throw err;
  }
}

if (process.argv[1]?.endsWith("initDb.ts")) {
  initializeDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
