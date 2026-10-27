import * as path from "node:path";
import * as fs from "node:fs";
import { SQLiteStore } from "../../dist/storage/sqlite/sqliteStore.js";
import { buildContext } from "../../dist/retrieval/relevantContext.js";
import { estimateTokens } from "../../dist/mcp/envelope.js";
import { VectorEngine } from "../../dist/retrieval/vectorStore.js";
import { LocalOnnxEmbeddingProvider } from "../../dist/retrieval/embeddingProvider.js";

export class OSSAnalyserAdapter {
  private store: SQLiteStore | null = null;
  private vectorEngine: VectorEngine | null = null;
  private embeddingProvider: LocalOnnxEmbeddingProvider | null = null;
  private dbPath: string;
  private repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = path.resolve(repoRoot);
    this.dbPath = path.join(this.repoRoot, ".oss-analyser", "knowledge.db");
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.dbPath)) {
      throw new Error(`OSS Analyser database not found at ${this.dbPath}. Please run index first.`);
    }
    this.store = new SQLiteStore(this.dbPath);
    await this.store.init();
    this.vectorEngine = new VectorEngine();
    this.embeddingProvider = new LocalOnnxEmbeddingProvider();
  }

  async close(): Promise<void> {
    if (this.store) {
      await this.store.close();
      this.store = null;
    }
    this.vectorEngine = null;
    this.embeddingProvider = null;
  }

  async queryCodeGraph(question: string, tokenBudget = 2000): Promise<string> {
    if (!this.store) {
      await this.init();
    }

    const firstRepo = await this.store.getFirstRepository();
    const effectiveRepoId = firstRepo?.id || path.basename(this.repoRoot);

    const ctx = await buildContext(
      question,
      {
        repoId: effectiveRepoId,
        repoRoot: this.repoRoot,
        maxTokens: tokenBudget,
        mode: "hybrid",
        embeddingProvider: this.embeddingProvider || undefined,
        vectorEngine: this.vectorEngine || undefined
      },
      this.store!
    );

    let output = `[OSS Analyser Graph Intelligence: "${question}"]\n`;
    output += `Retrieval Mode: ${ctx.retrievalMode} | Symbols: ${ctx.symbols.length} | Contracts: ${ctx.fileContracts.length}\n\n`;

    if (ctx.fileContracts.length > 0) {
      output += `### Target File Contracts:\n`;
      for (const fc of ctx.fileContracts.slice(0, 5)) {
        const contractDesc = fc.summary && fc.summary !== "pending_summary" ? ` - ${fc.summary}` : ` (${fc.why})`;
        output += `- \`${fc.filePath}\`: exports ${fc.exportedSymbolsCount} symbols${contractDesc}\n`;
      }
      output += `\n`;
    }

    if (ctx.symbols.length > 0) {
      output += `### Key Extracted Symbols & Signatures:\n`;
      for (const sym of ctx.symbols) {
        output += `• **${sym.name}** (${sym.nodeType})\n`;
        output += `  Location: \`${sym.sourcePointer}\`\n`;
        if (sym.signature) {
          output += `  Signature: \`${sym.signature}\`\n`;
        }
        if (sym.summary && sym.summary !== "pending_summary") {
          output += `  Contract/Summary: ${sym.summary}\n`;
        }
        if (sym.directCallers && sym.directCallers.length > 0) {
          output += `  Direct Callers: ${sym.directCallers.map((c) => c.name).join(", ")}\n`;
        }
        output += `\n`;
      }
    }

    if (ctx.callGraphEdges.length > 0) {
      output += `### Dependency & Call Graph Edges:\n`;
      for (const edge of ctx.callGraphEdges.slice(0, 15)) {
        output += `  ${edge.from} --[${edge.relation}]--> ${edge.to}\n`;
      }
      output += `\n`;
    }

    // Budget enforcement
    const tokens = estimateTokens(output);
    if (tokens > tokenBudget) {
      // Truncate cleanly if exceeds
      const maxChars = tokenBudget * 4;
      output = output.slice(0, maxChars) + `\n... [Truncated to stay within token budget of ${tokenBudget} tokens]`;
    }

    return output.trim();
  }
}
