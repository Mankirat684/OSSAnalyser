import * as path from "node:path";
import type { GraphStore, NodeRecord } from "../storage/graphStore.js";
import type { EmbeddingProvider } from "./embeddingProvider.js";
import { VectorEngine } from "./vectorStore.js";
import { formatPointer } from "../mcp/server.js";
import { estimateTokens } from "../mcp/envelope.js";

export interface RetrievalOptions {
  repoId: string;
  repoRoot: string;
  maxTokens?: number; // default 2000, cap 8000
  focusPaths?: string[];
  mode?: "hybrid" | "lexical" | "semantic";
  embeddingProvider?: EmbeddingProvider;
  vectorEngine?: VectorEngine;
}

export interface PackedSymbol {
  id: string;
  name: string;
  filePath: string;
  nodeType: string;
  sourcePointer: string;
  signature?: string | null;
  summary?: string | null;
  summaryStatus?: string;
  score: number;
  why: string;
  directCallers: Array<{ name: string; pointer: string }>; // Injected direct callers for confidence!
}

export interface PackedFileContract {
  filePath: string;
  summary: string;
  exportedSymbolsCount: number;
  why: string;
}

export interface ContextPackage {
  task: string;
  retrievalMode: "hybrid" | "lexical" | "semantic" | "lexical_fallback";
  repoOverview?: string | null;
  fileContracts: PackedFileContract[];
  symbols: PackedSymbol[];
  callGraphEdges: Array<{ from: string; to: string; relation: string }>;
  suggestedNextTools: string[];
}

const STOP_WORDS = new Set([
  "the", "is", "at", "which", "on", "a", "an", "and", "or", "to", "in", "of",
  "for", "with", "how", "what", "where", "why", "when", "does", "do", "can",
  "you", "i", "we", "my", "code", "function", "file", "method", "class"
]);

export function extractTaskIdentifiers(task: string): { identifiers: string[]; keywords: string[] } {
  const words = task.split(/[^a-zA-Z0-9_./-]+/).filter(Boolean);
  const identifiers: string[] = [];
  const keywords: string[] = [];

  for (const word of words) {
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;

    // Detect camelCase, snake_case, paths, or code identifiers
    if (
      /[a-z0-9][A-Z]/.test(word) ||
      word.includes("_") ||
      word.includes("/") ||
      word.includes(".") ||
      word.length >= 4
    ) {
      identifiers.push(word);
    } else {
      keywords.push(lower);
    }
  }

  return { identifiers, keywords };
}

export async function buildContext(
  task: string,
  options: RetrievalOptions,
  store: GraphStore
): Promise<ContextPackage> {
  const maxTokens = options.maxTokens && options.maxTokens > 0
    ? Math.min(options.maxTokens, 32000)
    : Infinity;
  const { identifiers, keywords } = extractTaskIdentifiers(task);

  let retrievalMode = options.mode || "hybrid";
  const seedScores = new Map<string, { node: NodeRecord; score: number; why: string }>();

  // 1. Exact Match Retriever
  for (const ident of identifiers) {
    const exactHit = await store.getNode(ident);
    if (exactHit) {
      seedScores.set(exactHit.id, {
        node: exactHit,
        score: 2.0,
        why: `exact identifier match '${ident}'`
      });
    }
  }

  // 2. FTS5 BM25 Lexical Retriever
  const ftsQuery = [...identifiers, ...keywords].join(" ");
  const ftsHits = ftsQuery ? await store.searchNodesFts(ftsQuery, 30) : [];
  const ftsRankMap = new Map<string, number>();
  ftsHits.forEach((hit, idx) => ftsRankMap.set(hit.nodeId, idx + 1));

  // 3. Vector Semantic Retriever (if hybrid/semantic and provider available)
  let vectorRankMap = new Map<string, number>();
  if (retrievalMode !== "lexical" && options.embeddingProvider && options.vectorEngine) {
    try {
      const [queryVec] = await options.embeddingProvider.embed([task], "query");
      const vectorHits = await options.vectorEngine.search(queryVec, store, options.repoId, 30);
      vectorHits.forEach((hit, idx) => vectorRankMap.set(hit.nodeId, idx + 1));
    } catch {
      retrievalMode = "lexical_fallback" as any;
    }
  } else if (retrievalMode === "semantic") {
    retrievalMode = "lexical_fallback" as any;
  }

  // 4. Reciprocal Rank Fusion (RRF, k = 60)
  const k = 60;
  const allCandidateIds = new Set<string>([
    ...seedScores.keys(),
    ...ftsRankMap.keys(),
    ...vectorRankMap.keys()
  ]);

  for (const nodeId of allCandidateIds) {
    const ftsRank = ftsRankMap.get(nodeId);
    const vecRank = vectorRankMap.get(nodeId);

    let rrfScore = 0;
    const whyParts: string[] = [];

    if (ftsRank != null) {
      rrfScore += 1.0 / (k + ftsRank);
      whyParts.push(`BM25 rank #${ftsRank}`);
    }
    if (vecRank != null) {
      rrfScore += 1.0 / (k + vecRank);
      whyParts.push(`semantic rank #${vecRank}`);
    }

    const existing = seedScores.get(nodeId);
    if (existing) {
      existing.score += rrfScore * 10;
      existing.why += ` + ${whyParts.join(", ")}`;
    } else {
      const node = await store.getNode(nodeId);
      if (node) {
        seedScores.set(nodeId, {
          node,
          score: rrfScore * 10,
          why: whyParts.join(", ")
        });
      }
    }
  }

  // Rank seeds by score descending
  const rankedSeeds = Array.from(seedScores.values()).sort((a, b) => b.score - a.score);

  // 5. Graph Expansion: 1-hop callers and callees + direct callers for top confident nodes
  const expandedSymbols = new Map<string, PackedSymbol>();
  const seedFiles = new Set<string>();

  for (const { node, score, why } of rankedSeeds.slice(0, 15)) {
    if (node.nodeType === "file") {
      seedFiles.add(node.filePath);
      continue;
    }

    seedFiles.add(node.filePath);

    // Fetch direct callers
    const callers = await store.getCallers(node.id, 1, false);
    const directCallers = callers.slice(0, 4).map((c) => ({
      name: c.name,
      pointer: formatPointer(c.filePath, c.line)
    }));

    expandedSymbols.set(node.id, {
      id: node.id,
      name: node.name,
      filePath: node.filePath,
      nodeType: node.nodeType,
      sourcePointer: formatPointer(node.filePath, node.startLine, node.endLine),
      signature: node.signature,
      summary: node.summary,
      summaryStatus: node.summaryStatus,
      score: Math.round(score * 100) / 100,
      why,
      directCallers
    });
  }

  // 6. Progressive Token Budget Packing
  const repo = await store.getRepository(options.repoId);
  const fileContracts: PackedFileContract[] = [];
  const packedSymbols: PackedSymbol[] = [];
  const callGraphEdges: Array<{ from: string; to: string; relation: string }> = [];

  // Tier 1: File Contracts
  for (const fPath of seedFiles) {
    const nodes = await store.getNodesByFilePath(fPath);
    const fileNode = nodes.find((n) => n.nodeType === "file");
    const exportedCount = nodes.filter((n) => (n.metadata as any)?.exported).length;

    fileContracts.push({
      filePath: fPath,
      summary: fileNode?.summary || `Module containing ${nodes.length} symbols.`,
      exportedSymbolsCount: exportedCount,
      why: "contains matched symbols"
    });
  }

  // Tier 2: Top symbols with source pointers and injected direct callers
  for (const sym of expandedSymbols.values()) {
    packedSymbols.push(sym);
  }

  // Tier 3: Inter-symbol Call Graph Edges
  const symbolIds = new Set(packedSymbols.map((s) => s.id));
  for (const sym of packedSymbols) {
    const deps = await store.getDependencies(sym.id, 1, false);
    for (const dep of deps) {
      if (symbolIds.has(dep.id)) {
        callGraphEdges.push({
          from: sym.name,
          to: dep.name,
          relation: dep.relation
        });
      }
    }
  }

  // Package assembly
  const contextPackage: ContextPackage = {
    task,
    retrievalMode,
    repoOverview: repo?.architectureSummary?.split("\n")[0] || null,
    fileContracts: fileContracts.slice(0, 5),
    symbols: packedSymbols.slice(0, 8),
    callGraphEdges: callGraphEdges.slice(0, 10),
    suggestedNextTools: ["get_symbol", "get_blast_radius", "get_file_contract"]
  };

  return contextPackage;
}
