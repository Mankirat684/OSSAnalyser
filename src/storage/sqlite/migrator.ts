import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

export interface MigrationResult {
  applied: Array<{ version: number; name: string }>;
  currentVersion: number;
}

/**
 * Finds the migrations folder in either development (src/) or compiled (dist/) environments.
 */
export function resolveMigrationsDir(): string {
  // 1. Check adjacent directory (compiled dist/storage/sqlite/migrations or tsx runtime)
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const adjacent = path.join(currentDir, "migrations");
  if (fs.existsSync(adjacent)) {
    return adjacent;
  }

  // 2. Check src directory relative to cwd
  const srcPath = path.resolve(process.cwd(), "src", "storage", "sqlite", "migrations");
  if (fs.existsSync(srcPath)) {
    return srcPath;
  }

  // 3. Fallback to dist directory relative to cwd
  const distPath = path.resolve(process.cwd(), "dist", "storage", "sqlite", "migrations");
  if (fs.existsSync(distPath)) {
    return distPath;
  }

  return adjacent;
}

/**
 * Executes all pending numbered migrations in alphabetical/version order.
 * Tracks applied version using SQLite's native PRAGMA user_version.
 */
export function runMigrations(db: Database.Database): MigrationResult {
  const migrationsDir = resolveMigrationsDir();
  const applied: Array<{ version: number; name: string }> = [];

  let currentVersion = (db.pragma("user_version", { simple: true }) as number) || 0;

  if (!fs.existsSync(migrationsDir)) {
    return { applied, currentVersion };
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) continue;

    const version = parseInt(match[1], 10);
    if (version <= currentVersion) {
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, "utf-8");

    // Execute migration and update PRAGMA user_version atomically
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    });

    applyMigration();
    applied.push({ version, name: file });
    currentVersion = version;
  }

  return { applied, currentVersion };
}
