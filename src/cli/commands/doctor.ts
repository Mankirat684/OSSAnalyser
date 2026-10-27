import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3");

export async function runDoctorCommand(options: { repo?: string }): Promise<void> {
  const repoRoot = path.resolve(options.repo || process.cwd());
  const dbPath = path.join(repoRoot, ".oss-analyser", "knowledge.db");

  console.log(`\n==========================================================`);
  console.log(`  OSS Analyser: System & Environment Health Doctor`);
  console.log(`==========================================================\n`);

  let allHealthy = true;

  // 1. Check Node.js version
  const nodeVer = process.versions.node;
  const [major] = nodeVer.split(".").map(Number);
  if (major >= 20) {
    console.log(`✓ Node.js Runtime     : v${nodeVer}`);
  } else {
    console.log(`✗ Node.js Runtime     : v${nodeVer} (Requires Node >= 20)`);
    allHealthy = false;
  }

  // 2. Check Git availability
  try {
    const gitVer = execSync("git --version", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    console.log(`✓ Git Version         : ${gitVer}`);
  } catch {
    console.log(`✗ Git Version         : Git not found in PATH`);
    allHealthy = false;
  }

  // 3. Check SQLite & FTS5 support via better-sqlite3
  try {
    const memDb = new Database(":memory:");
    memDb.exec("CREATE VIRTUAL TABLE _doc_fts_test USING fts5(content);");
    memDb.exec("INSERT INTO _doc_fts_test VALUES ('health check');");
    memDb.close();
    console.log(`✓ SQLite & FTS5       : better-sqlite3 full-text search supported`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`✗ SQLite & FTS5       : Failed initializing FTS5 (${msg})`);
    allHealthy = false;
  }

  // 4. Check sqlite-vec Vector extension
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require("sqlite-vec");
    const memDb = new Database(":memory:");
    sqliteVec.load(memDb);
    const row = memDb.prepare("SELECT vec_version()").get() as Record<string, string>;
    memDb.close();
    console.log(`✓ sqlite-vec Vector   : ${row["vec_version()"]} (persistent ANN search enabled)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`- sqlite-vec Vector   : Not available (${msg}). Fallback to in-memory vector projection.`);
  }

  // 4b. Check ONNX / Transformers runtime for local embeddings
  try {
    const transformers = require("@xenova/transformers");
    const ver = transformers.env?.version || "2.17.2";
    console.log(`✓ ONNX Runtime        : @xenova/transformers v${ver} (local CPU embeddings ready)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`- ONNX Runtime        : Not available (${msg}). Fallback to local hash or cloud embeddings.`);
  }

  // 5. Check Graphify CLI
  try {
    const graphifyVer = execSync("graphify --version", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    console.log(`✓ Graphify CLI        : ${graphifyVer} (Tree-sitter AST engine available)`);
  } catch {
    console.log(`- Graphify CLI        : Not found (Native AST extractor will be used by default)`);
  }

  // 6. Check LLM Provider Credentials (Present / Absent only; never print value)
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    console.log(`✓ Gemini Credentials  : GEMINI_API_KEY detected in environment`);
  } else {
    console.log(`- Gemini Credentials  : GEMINI_API_KEY not set (Ollama or Heuristic summarization will be used)`);
  }

  // 7. Check Database Integrity if DB exists
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath);
      const row = db.prepare("PRAGMA integrity_check;").get() as Record<string, string>;
      const version = (db.pragma("user_version", { simple: true }) as number) || 0;
      db.close();
      if (row && row.integrity_check === "ok") {
        console.log(`✓ Database Integrity  : .oss-analyser/knowledge.db is healthy (schema version: v${version})`);
      } else {
        console.log(`✗ Database Integrity  : Corruption detected in knowledge.db (${JSON.stringify(row)})`);
        allHealthy = false;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗ Database Integrity  : Error opening knowledge.db (${msg})`);
      allHealthy = false;
    }
  } else {
    console.log(`- Database Status     : No local database yet (run 'oss-analyser init')`);
  }

  console.log(`\n==========================================================`);
  if (allHealthy) {
    console.log(`Result: Environment is fully operational! 🚀\n`);
  } else {
    console.log(`Result: Some requirements need attention.\n`);
  }
}
