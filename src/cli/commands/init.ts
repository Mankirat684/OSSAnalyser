import * as fs from "node:fs";
import * as path from "node:path";
import { SQLiteStore } from "../../storage/sqlite/sqliteStore.js";

export interface InitOptions {
  repo?: string;
  force?: boolean;
}

export async function runInitCommand(options: InitOptions): Promise<void> {
  const repoRoot = path.resolve(options.repo || process.cwd());
  const ossDir = path.join(repoRoot, ".oss-analyser");
  const dbPath = path.join(ossDir, "knowledge.db");
  const configPath = path.join(ossDir, "config.json");

  console.log(`\nInitializing OSS Analyser in: ${repoRoot}`);

  if (!fs.existsSync(ossDir)) {
    fs.mkdirSync(ossDir, { recursive: true });
    console.log(`✓ Created directory: .oss-analyser/`);
  }

  // 1. Add to .git/info/exclude if git repository
  const gitInfoDir = path.join(repoRoot, ".git", "info");
  const gitExcludePath = path.join(gitInfoDir, "exclude");
  if (fs.existsSync(gitInfoDir)) {
    let excludeContent = "";
    if (fs.existsSync(gitExcludePath)) {
      excludeContent = fs.readFileSync(gitExcludePath, "utf-8");
    }
    if (!excludeContent.includes(".oss-analyser/")) {
      const newLine = excludeContent.endsWith("\n") || !excludeContent ? "" : "\n";
      fs.appendFileSync(gitExcludePath, `${newLine}# OSS Analyser local context database\n.oss-analyser/\n`, "utf-8");
      console.log(`✓ Added .oss-analyser/ to .git/info/exclude (clean git status preserved)`);
    }
  }

  // 2. Initialize default config.json
  if (!fs.existsSync(configPath) || options.force) {
    const defaultConfig = {
      schemaVersion: "1.0.0",
      extractor: "native",
      provider: "gemini",
      model: "gemini-3.5-flash-lite",
      maxToolTokens: 2000,
      hardCapTokens: 8000,
      exposeAuthorEmails: false,
      storeRawCode: false,
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
    console.log(`✓ Created configuration: .oss-analyser/config.json`);
  }

  // 3. Initialize SQLite Schema
  const store = new SQLiteStore(dbPath);
  await store.init();
  await store.setMeta("schema_version", "1.0.0");
  await store.setMeta("created_at", new Date().toISOString());
  await store.close();
  console.log(`✓ Initialized SQLite database: .oss-analyser/knowledge.db`);

  console.log(`\n🎉 Initialization complete!`);
  console.log(`Next step: Run 'npx oss-analyser index' to index codebase structure.\n`);
}
