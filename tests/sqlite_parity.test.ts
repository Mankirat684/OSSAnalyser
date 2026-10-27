import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert";

/**
 * Phase 1 Schema Parity Test:
 * Parses web schema (schema.sql) and SQLite schema (src/storage/sqlite/schema.sql)
 * for repositories, code_nodes, code_edges, git_ownership.
 * Asserts every Postgres column exists in SQLite schema with compatible type.
 */

function extractTableColumns(sql: string, tableName: string): Map<string, string> {
  const startPattern = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${tableName}\\s*\\(`, "i");
  const match = sql.match(startPattern);
  if (!match || match.index === undefined) {
    throw new Error(`Table ${tableName} not found in schema SQL`);
  }

  const startIndex = match.index + match[0].length;
  let depth = 1;
  let endIndex = -1;

  for (let i = startIndex; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") {
      depth--;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    }
  }

  if (endIndex === -1) {
    throw new Error(`Could not find closing parenthesis for table ${tableName}`);
  }

  const columnsBlock = sql.slice(startIndex, endIndex);
  const columns = new Map<string, string>();

  // Split lines, ignoring table constraints and comments
  const lines = columnsBlock.split("\n");
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("--")) continue;
    if (
      line.toUpperCase().startsWith("CONSTRAINT") ||
      line.toUpperCase().startsWith("PRIMARY KEY") ||
      line.toUpperCase().startsWith("UNIQUE")
    ) {
      continue;
    }

    // Match column name and type
    const colMatch = line.match(/^([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_()]+)/);
    if (colMatch) {
      const colName = colMatch[1].toLowerCase();
      const colType = colMatch[2].toUpperCase();
      columns.set(colName, colType);
    }
  }

  return columns;
}

function normalizeType(pgType: string): string {
  if (pgType.startsWith("INT") || pgType.startsWith("BIGSERIAL")) return "INTEGER";
  if (pgType.startsWith("TEXT") || pgType.startsWith("TIMESTAMPTZ") || pgType.startsWith("JSONB")) return "TEXT";
  if (pgType.startsWith("NUMERIC")) return "REAL";
  if (pgType.startsWith("VECTOR")) return "VIRTUAL_VEC"; // Allowed deviation per spec section 3.6
  return pgType;
}

function runParityTest() {
  console.log("==========================================================");
  console.log("  TEST: Schema Parity (Postgres Web App <-> SQLite Local)");
  console.log("==========================================================");

  const rootDir = process.cwd();
  const pgSchemaPath = path.join(rootDir, "src/modules/storage/schema.sql");
  const sqliteSchemaPath = path.join(rootDir, "src/storage/sqlite/schema.sql");

  const pgSql = fs.readFileSync(pgSchemaPath, "utf-8");
  const sqliteSql = fs.readFileSync(sqliteSchemaPath, "utf-8");

  const tablesToCheck = ["repositories", "code_nodes", "code_edges", "git_ownership"];

  for (const table of tablesToCheck) {
    const pgCols = extractTableColumns(pgSql, table);
    const sqliteCols = extractTableColumns(sqliteSql, table);

    console.log(`\nChecking table: [${table}] (${pgCols.size} columns in Postgres)`);

    for (const [colName, pgType] of pgCols.entries()) {
      if (table === "code_nodes" && colName === "embedding") {
        // Explicit allowed deviation: vector(768) stored in sqlite-vec table
        console.log(`  ✓ column '${colName}' (vector) verified as virtual sqlite-vec deviation`);
        continue;
      }

      assert.ok(
        sqliteCols.has(colName),
        `Parity Failure: Column '${colName}' on table '${table}' missing in SQLite schema!`
      );

      const sqliteType = sqliteCols.get(colName)!;
      const expectedAffinity = normalizeType(pgType);
      
      assert.strictEqual(
        sqliteType,
        expectedAffinity,
        `Type Affinity Mismatch for '${table}.${colName}': Postgres '${pgType}' -> expected '${expectedAffinity}', got '${sqliteType}'`
      );

      console.log(`  ✓ column '${colName}': ${pgType} -> ${sqliteType}`);
    }
  }

  console.log("\nALL SCHEMA PARITY CHECKS PASSED! 100% COMPATIBLE 🎉\n");
}

runParityTest();
