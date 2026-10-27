import * as path from "node:path";
import * as fs from "node:fs";
import { SQLiteStore } from "../../storage/sqlite/sqliteStore.js";
import { formatPointer } from "../../mcp/server.js";

export interface ImpactOptions {
  depth?: number;
  includeInferred?: boolean;
  json?: boolean;
  repo?: string;
}

export async function runImpactCommand(symbolOrPath: string, options: ImpactOptions): Promise<void> {
  const repoRoot = path.resolve(options.repo || process.cwd());
  const dbPath = path.join(repoRoot, ".oss-analyser", "knowledge.db");

  if (!fs.existsSync(dbPath)) {
    console.error(`Knowledge database not found at ${dbPath}. Run 'oss-analyser init' and 'oss-analyser index' first.`);
    process.exit(1);
  }

  const store = new SQLiteStore(dbPath);
  await store.init();

  const node = await store.getNode(symbolOrPath);
  if (!node) {
    console.error(`Symbol '${symbolOrPath}' not found in knowledge database.`);
    const matches = await store.searchNodesFts(symbolOrPath, 5);
    if (matches.length > 0) {
      console.log(`Did you mean one of these?`);
      for (const m of matches) {
        console.log(`  • ${m.name} (${m.filePath})`);
      }
    }
    await store.close();
    process.exit(1);
  }

  const maxDepth = options.depth ? Number(options.depth) : 3;
  const items = await store.getBlastRadius(node.id, maxDepth, options.includeInferred);
  await store.close();

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          target: {
            id: node.id,
            name: node.name,
            sourcePointer: formatPointer(node.filePath, node.startLine, node.endLine)
          },
          totalAffected: items.length,
          impacted: items
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n==========================================================`);
  console.log(`  OSS Analyser: Blast Radius Impact Report`);
  console.log(`==========================================================`);
  console.log(`Target Symbol  : ${node.name} (${node.nodeType})`);
  console.log(`Source Location: ${formatPointer(node.filePath, node.startLine, node.endLine)}`);
  console.log(`Max Depth      : ${maxDepth}`);
  console.log(`Total Impacted : ${items.length} upstream caller(s)\n`);

  if (items.length === 0) {
    console.log(`✓ Zero upstream callers affected. Modifying this symbol has zero blast radius.\n`);
    return;
  }

  // Group by depth
  const byDepth = new Map<number, typeof items>();
  for (const item of items) {
    const list = byDepth.get(item.depth) || [];
    list.push(item);
    byDepth.set(item.depth, list);
  }

  for (let d = 1; d <= maxDepth; d++) {
    const atDepth = byDepth.get(d);
    if (!atDepth || atDepth.length === 0) continue;

    console.log(`Depth ${d} (${atDepth.length} callers):`);
    for (const item of atDepth) {
      const cycleFlag = item.viaCycle ? " [via cycle]" : "";
      const isTest = item.filePath.includes(".test.") || item.filePath.includes(".spec.") ? " [test]" : "";
      console.log(`  ↳ ${item.name} (${item.filePath})${cycleFlag}${isTest}`);
    }
    console.log();
  }
}
