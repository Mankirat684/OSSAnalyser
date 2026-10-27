import * as path from "node:path";
import * as fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { GraphStore, NodeRecord } from "../storage/graphStore.js";
import { SQLiteStore } from "../storage/sqlite/sqliteStore.js";
import { EnvelopeBuilder, paginateItems } from "./envelope.js";
import { normalizeRelPath } from "../pipeline/idGenerator.js";
import { buildContext } from "../retrieval/relevantContext.js";
import { VectorEngine, type VectorSearchResult } from "../retrieval/vectorStore.js";
import { type EmbeddingProvider, getDefaultEmbeddingProvider } from "../retrieval/embeddingProvider.js";
import { getNextAgentBatch, saveAgentBatch, resetRepoSummaries } from "../summarizer/agentSummarizer.js";

export function assertSafePath(repoRoot: string, userPath: string): string {
  const resolved = path.resolve(repoRoot, userPath);
  const rel = path.relative(repoRoot, resolved);
  if (rel.startsWith("..") || (path.isAbsolute(userPath) && !resolved.startsWith(repoRoot))) {
    throw new Error(`Security Violation: Path traversal rejected for '${userPath}'`);
  }
  return resolved;
}

export function formatPointer(filePath: string, startLine?: number | null, endLine?: number | null): string {
  if (startLine != null && endLine != null) {
    return `${filePath}:${startLine}-${endLine}`;
  }
  if (startLine != null) {
    return `${filePath}:${startLine}`;
  }
  return filePath;
}

export function createMcpServer(
  store: GraphStore,
  repoRoot: string,
  repoId: string,
  vectorEngine?: VectorEngine,
  embeddingProvider?: EmbeddingProvider
): McpServer {
  const vEngine = vectorEngine || new VectorEngine();
  const eProvider = embeddingProvider || getDefaultEmbeddingProvider();
  let embedded = false;

  async function ensureEmbedded(): Promise<void> {
    if (embedded) return;
    try {
      await vEngine.embedNodes(store, repoId, eProvider);
      embedded = true;
    } catch {
      // Fallback if embedding generation encounters errors
    }
  }

  const server = new McpServer({
    name: "oss-analyser",
    version: "1.0.0"
  });

  const TOOL_NOTE = "Summaries are generated and may be outdated; verify against the source before editing.";

  // -------------------------------------------------------------------------
  // 1. search_symbols
  // -------------------------------------------------------------------------
  server.tool(
    "search_symbols",
    `Search functions, classes, and methods as a search primitive (like grep). Supports semantic vector search, BM25 lexical search, or hybrid search. Returns nearest matching nodes with signatures, locations, one-line summaries, and similarity scores. ${TOOL_NOTE}`,
    {
      query: z.string().describe("Symbol name, identifier, natural-language query, or keyword to find"),
      mode: z.enum(["hybrid", "lexical", "semantic"]).optional().describe("Search mode: 'semantic' (embedding similarity), 'lexical' (BM25 FTS5), or 'hybrid' (combined RRF) (default: hybrid)"),
      limit: z.union([z.number().min(1), z.literal("all")]).optional().describe("Number of symbols to return per page, or 'all' (default: 20)"),
      cursor: z.string().optional().describe("Pagination cursor (next_cursor from previous response)"),
      max_tokens: z.number().optional().describe("Optional token budget limit")
    },
    async ({ query, mode = "hybrid", limit = 20, cursor, max_tokens }) => {
      interface SearchSymbolItem {
        id: string;
        name: string;
        nodeType: string;
        signature?: string | null;
        sourcePointer: string;
        summary?: string | null;
        score?: number;
      }

      let allSymbols: SearchSymbolItem[] = [];

      if (mode === "lexical") {
        const ftsLimit = limit === "all" ? 500 : 200;
        const results = await store.searchNodesFts(query, ftsLimit);
        allSymbols = results.map((r) => ({
          id: r.nodeId,
          name: r.name,
          nodeType: r.nodeType,
          signature: r.signature,
          sourcePointer: r.filePath,
          summary: r.summary && r.summary !== "pending_summary" ? r.summary : undefined,
          score: r.rank != null ? Math.round(r.rank * 100) / 100 : undefined
        }));
      } else if (mode === "semantic") {
        try {
          await ensureEmbedded();
          const [queryVec] = await eProvider.embed([query], "query");
          const searchLimit = limit === "all" ? 200 : Math.max(50, typeof limit === "number" ? limit * 2 : 50);
          const vecHits = await vEngine.search(queryVec, store, repoId, searchLimit);
          allSymbols = vecHits.map((h) => ({
            id: h.nodeId,
            name: h.name,
            nodeType: h.nodeType,
            signature: h.signature,
            sourcePointer: h.sourcePointer || h.filePath,
            summary: h.summary && h.summary !== "pending_summary" ? h.summary : undefined,
            score: h.similarity
          }));
        } catch {
          // Graceful fallback to lexical if vector provider fails
          const ftsLimit = limit === "all" ? 500 : 200;
          const results = await store.searchNodesFts(query, ftsLimit);
          allSymbols = results.map((r) => ({
            id: r.nodeId,
            name: r.name,
            nodeType: r.nodeType,
            signature: r.signature,
            sourcePointer: r.filePath,
            summary: r.summary && r.summary !== "pending_summary" ? r.summary : undefined,
            score: r.rank != null ? Math.round(r.rank * 100) / 100 : undefined
          }));
        }
      } else {
        // hybrid mode (default): combine BM25 lexical + semantic vector with RRF
        try {
          await ensureEmbedded();
          const [queryVec] = await eProvider.embed([query], "query");
          const searchLimit = limit === "all" ? 200 : Math.max(50, typeof limit === "number" ? limit * 2 : 50);
          const [ftsHits, vecHits] = await Promise.all([
            store.searchNodesFts(query, searchLimit),
            vEngine.search(queryVec, store, repoId, searchLimit)
          ]);

          const k = 60;
          const scores = new Map<string, { item: SearchSymbolItem; rrf: number }>();

          ftsHits.forEach((hit, idx) => {
            const rrf = 1.0 / (k + idx + 1);
            scores.set(hit.nodeId, {
              item: {
                id: hit.nodeId,
                name: hit.name,
                nodeType: hit.nodeType,
                signature: hit.signature,
                sourcePointer: hit.filePath,
                summary: hit.summary && hit.summary !== "pending_summary" ? hit.summary : undefined
              },
              rrf
            });
          });

          vecHits.forEach((hit, idx) => {
            const rrf = 1.0 / (k + idx + 1);
            const existing = scores.get(hit.nodeId);
            if (existing) {
              existing.rrf += rrf;
              if (!existing.item.summary && hit.summary && hit.summary !== "pending_summary") {
                existing.item.summary = hit.summary;
              }
              if (!existing.item.signature && hit.signature) {
                existing.item.signature = hit.signature;
              }
            } else {
              scores.set(hit.nodeId, {
                item: {
                  id: hit.nodeId,
                  name: hit.name,
                  nodeType: hit.nodeType,
                  signature: hit.signature,
                  sourcePointer: hit.sourcePointer || hit.filePath,
                  summary: hit.summary && hit.summary !== "pending_summary" ? hit.summary : undefined
                },
                rrf
              });
            }
          });

          allSymbols = Array.from(scores.values())
            .sort((a, b) => b.rrf - a.rrf)
            .map((entry) => ({
              ...entry.item,
              score: Math.round(entry.rrf * 1000) / 1000
            }));
        } catch {
          // Fallback to lexical if vector search fails
          const ftsLimit = limit === "all" ? 500 : 200;
          const results = await store.searchNodesFts(query, ftsLimit);
          allSymbols = results.map((r) => ({
            id: r.nodeId,
            name: r.name,
            nodeType: r.nodeType,
            signature: r.signature,
            sourcePointer: r.filePath,
            summary: r.summary && r.summary !== "pending_summary" ? r.summary : undefined,
            score: r.rank != null ? Math.round(r.rank * 100) / 100 : undefined
          }));
        }
      }

      const page = paginateItems(allSymbols, limit, cursor, 20);

      const meta = await EnvelopeBuilder.createMeta(store, max_tokens, ["get_symbol", "get_callers", "get_blast_radius"], repoRoot);
      return EnvelopeBuilder.wrap(
        {
          query,
          mode,
          total: page.total,
          returned: page.returned,
          next_cursor: page.next_cursor,
          symbols: page.items
        },
        meta
      );
    }
  );

  // -------------------------------------------------------------------------
  // 2. get_symbol
  // -------------------------------------------------------------------------
  server.tool(
    "get_symbol",
    `Get detailed interface contract, summary, authorship, and caller/callee counts for a symbol. ${TOOL_NOTE}`,
    {
      id_or_name: z.string().describe("Symbol identifier or function name"),
      max_tokens: z.number().optional().describe("Maximum response token budget (default 2000, cap 8000)")
    },
    async ({ id_or_name, max_tokens }) => {
      const node = await store.getNode(id_or_name);
      if (!node) {
        // Check for potential candidates matching name
        const matches = await store.searchNodesFts(id_or_name, 5);
        const meta = await EnvelopeBuilder.createMeta(store, max_tokens, ["search_symbols"], repoRoot);
        return EnvelopeBuilder.wrap(
          {
            error: `Symbol not found: '${id_or_name}'`,
            suggestedCandidates: matches.map((m) => ({ id: m.nodeId, name: m.name, filePath: m.filePath }))
          },
          meta
        );
      }

      const callers = await store.getCallers(node.id, 1, false);
      const callees = await store.getDependencies(node.id, 1, false);
      const ownership = await store.getOwnership(node.id);

      const symbolData = {
        id: node.id,
        name: node.name,
        qualifiedName: (node.metadata as any)?.qualified_name !== node.name ? (node.metadata as any)?.qualified_name : undefined,
        nodeType: node.nodeType,
        sourcePointer: formatPointer(node.filePath, node.startLine, node.endLine),
        signature: node.signature,
        docComment: (node.metadata as any)?.doc_comment || undefined,
        summary: node.summary && node.summary !== "pending_summary" ? node.summary : undefined,
        summaryStatus: node.summaryStatus !== "missing" ? node.summaryStatus : undefined,
        sccId: node.sccId ?? undefined,
        callersCount: callers.length,
        calleesCount: callees.length,
        topContributors: ownership.length > 0 ? ownership.slice(0, 3).map((o) => ({
          authorName: o.authorName,
          linesAuthored: o.linesAuthored,
          ownershipPercentage: o.ownershipPercentage,
          lastCommitDate: o.lastCommitDate
        })) : undefined
      };

      const meta = await EnvelopeBuilder.createMeta(
        store,
        max_tokens,
        ["get_callers", "get_dependencies", "get_blast_radius", "get_file_contract"],
        repoRoot
      );
      return EnvelopeBuilder.wrap({ symbol: symbolData }, meta);
    }
  );

  // -------------------------------------------------------------------------
  // 3. get_file_contract
  // -------------------------------------------------------------------------
  server.tool(
    "get_file_contract",
    `Inspect a file's purpose, exported symbols, and structural contract without loading raw source. Supports pagination. ${TOOL_NOTE}`,
    {
      path: z.string().describe("Relative path to source file (e.g., src/services/userService.ts)"),
      limit: z.union([z.number().min(1), z.literal("all")]).optional().describe("Number of exported symbols to return per page, or 'all' (default: 'all')"),
      cursor: z.string().optional().describe("Pagination cursor"),
      max_tokens: z.number().optional().describe("Optional token budget limit")
    },
    async ({ path: userPath, limit = "all", cursor, max_tokens }) => {
      assertSafePath(repoRoot, userPath);
      const normPath = normalizeRelPath(userPath);

      const nodes = await store.getNodesByFilePath(normPath);
      const fileNode = nodes.find((n) => n.nodeType === "file");
      const symbols = nodes.filter((n) => n.nodeType !== "file");

      const allExported = symbols
        .filter((s) => (s.metadata as Record<string, unknown>)?.exported)
        .map((s) => ({
          id: s.id,
          name: s.name,
          nodeType: s.nodeType,
          signature: s.signature,
          sourcePointer: formatPointer(s.filePath, s.startLine, s.endLine),
          summary: s.summary && s.summary !== "pending_summary" ? s.summary : undefined
        }));

      const page = paginateItems(allExported, limit, cursor, 50);

      const contract = {
        filePath: normPath,
        summary: fileNode?.summary && fileNode.summary !== "pending_summary" ? fileNode.summary : undefined,
        summaryStatus: fileNode?.summaryStatus && fileNode.summaryStatus !== "missing" ? fileNode.summaryStatus : undefined,
        totalSymbols: symbols.length,
        totalExported: page.total,
        returned: page.returned,
        next_cursor: page.next_cursor,
        exportedSymbols: page.items,
        internalSymbolsCount: symbols.length - allExported.length > 0 ? symbols.length - allExported.length : undefined
      };

      const meta = await EnvelopeBuilder.createMeta(store, max_tokens, ["get_symbol", "get_dependencies"], repoRoot);
      return EnvelopeBuilder.wrap({ contract }, meta);
    }
  );

  // -------------------------------------------------------------------------
  // 4. get_module_summary
  // -------------------------------------------------------------------------
  server.tool(
    "get_module_summary",
    `Get high-level module/directory rollup, responsibilities, and child files. Supports pagination. ${TOOL_NOTE}`,
    {
      path: z.string().describe("Directory or module path (e.g., src/services)"),
      limit: z.union([z.number().min(1), z.literal("all")]).optional().describe("Number of child files to return per page, or 'all' (default: 50)"),
      cursor: z.string().optional().describe("Pagination cursor"),
      max_tokens: z.number().optional().describe("Optional token budget limit")
    },
    async ({ path: userPath, limit = 50, cursor, max_tokens }) => {
      assertSafePath(repoRoot, userPath);
      const normDir = normalizeRelPath(userPath);

      const allNodes = await store.getAllNodes(repoId);
      const childFiles = allNodes.filter(
        (n) => n.nodeType === "file" && (normDir === "" || n.filePath.startsWith(`${normDir}/`))
      );

      const rawFiles = childFiles.map((f) => ({
        filePath: f.filePath,
        summary: f.summary,
        summaryStatus: f.summaryStatus
      }));

      const page = paginateItems(rawFiles, limit, cursor, 50);

      const moduleSummary = {
        modulePath: normDir || "root",
        total: page.total,
        returned: page.returned,
        next_cursor: page.next_cursor,
        files: page.items
      };

      const meta = await EnvelopeBuilder.createMeta(store, max_tokens, ["get_file_contract", "get_architecture_summary"], repoRoot);
      return EnvelopeBuilder.wrap({ moduleSummary }, meta);
    }
  );

  // -------------------------------------------------------------------------
  // 5. get_dependencies
  // -------------------------------------------------------------------------
  server.tool(
    "get_dependencies",
    `View downstream functions and modules called by a symbol. Supports pagination. ${TOOL_NOTE}`,
    {
      id_or_name: z.string().describe("Symbol ID or function name"),
      depth: z.number().min(1).max(3).optional().describe("Traversal depth (default: 1)"),
      include_inferred: z.boolean().optional().describe("Include untyped or name-only calls (default: true)"),
      limit: z.union([z.number().min(1), z.literal("all")]).optional().describe("Number of dependencies to return per page, or 'all' (default: 50)"),
      cursor: z.string().optional().describe("Pagination cursor (next_cursor from previous response)"),
      max_tokens: z.number().optional().describe("Optional token budget limit")
    },
    async ({ id_or_name, depth = 1, include_inferred = true, limit = 50, cursor, max_tokens }) => {
      const node = await store.getNode(id_or_name);
      if (!node) {
        const meta = await EnvelopeBuilder.createMeta(store, max_tokens, ["search_symbols"], repoRoot);
        return EnvelopeBuilder.wrap({ error: `Symbol not found: '${id_or_name}'` }, meta);
      }

      const deps = await store.getDependencies(node.id, depth, include_inferred);
      const rawDeps = deps.map((d) => ({
        id: d.id,
        name: d.name,
        nodeType: d.nodeType,
        relation: d.relation,
        confidence: d.confidence,
        sourcePointer: d.filePath,
        line: d.line
      }));

      const page = paginateItems(rawDeps, limit, cursor, 50);

      const meta = await EnvelopeBuilder.createMeta(store, max_tokens, ["get_symbol", "get_blast_radius"], repoRoot);
      return EnvelopeBuilder.wrap(
        {
          symbol: node.name,
          sourcePointer: formatPointer(node.filePath, node.startLine, node.endLine),
          total: page.total,
          returned: page.returned,
          next_cursor: page.next_cursor,
          dependencies: page.items
        },
        meta
      );
    }
  );

  // -------------------------------------------------------------------------
  // 6. get_callers
  // -------------------------------------------------------------------------
  server.tool(
    "get_callers",
    `View upstream functions that call this symbol. Supports pagination. ${TOOL_NOTE}`,
    {
      id_or_name: z.string().describe("Symbol ID or function name"),
      depth: z.number().min(1).max(3).optional().describe("Traversal depth (default: 1)"),
      include_inferred: z.boolean().optional().describe("Include inferred call sites (default: true)"),
      limit: z.union([z.number().min(1), z.literal("all")]).optional().describe("Number of callers to return per page, or 'all' (default: 50)"),
      cursor: z.string().optional().describe("Pagination cursor (next_cursor from previous response)"),
      max_tokens: z.number().optional().describe("Optional token budget limit")
    },
    async ({ id_or_name, depth = 1, include_inferred = true, limit = 50, cursor, max_tokens }) => {
      const node = await store.getNode(id_or_name);
      if (!node) {
        const meta = await EnvelopeBuilder.createMeta(store, max_tokens, ["search_symbols"], repoRoot);
        return EnvelopeBuilder.wrap({ error: `Symbol not found: '${id_or_name}'` }, meta);
      }

      const callers = await store.getCallers(node.id, depth, include_inferred);
      const rawCallers = callers.map((c) => ({
        id: c.id,
        name: c.name,
        nodeType: c.nodeType,
        relation: c.relation,
        confidence: c.confidence,
        sourcePointer: c.filePath,
        line: c.line
      }));

      const page = paginateItems(rawCallers, limit, cursor, 50);

      const meta = await EnvelopeBuilder.createMeta(store, max_tokens, ["get_blast_radius", "get_symbol"], repoRoot);
      return EnvelopeBuilder.wrap(
        {
          symbol: node.name,
          sourcePointer: formatPointer(node.filePath, node.startLine, node.endLine),
          total: page.total,
          returned: page.returned,
          next_cursor: page.next_cursor,
          callers: page.items
        },
        meta
      );
    }
  );

  // -------------------------------------------------------------------------
  // 7. get_blast_radius
  // -------------------------------------------------------------------------
  server.tool(
    "get_blast_radius",
    `Compute transitive upstream callers and affected files using recursive CTE graph analysis. Supports pagination. ${TOOL_NOTE}`,
    {
      id_or_name: z.string().describe("Symbol ID or function name"),
      max_depth: z.number().min(1).max(6).optional().describe("Maximum recursive depth (default 3, max 6)"),
      include_inferred: z.boolean().optional().describe("Include inferred edges (default true)"),
      limit: z.union([z.number().min(1), z.literal("all")]).optional().describe("Number of impacted symbols to return per page, or 'all' (default: 50)"),
      cursor: z.string().optional().describe("Pagination cursor (next_cursor from previous response)"),
      max_tokens: z.number().optional().describe("Optional token budget limit")
    },
    async ({ id_or_name, max_depth = 3, include_inferred = true, limit = 50, cursor, max_tokens }) => {
      const node = await store.getNode(id_or_name);
      if (!node) {
        const meta = await EnvelopeBuilder.createMeta(store, max_tokens, ["search_symbols"], repoRoot);
        return EnvelopeBuilder.wrap({ error: `Symbol not found: '${id_or_name}'` }, meta);
      }

      const items = await store.getBlastRadius(node.id, max_depth, include_inferred);

      const affectedFiles = new Set<string>();
      for (const item of items) {
        affectedFiles.add(item.filePath);
      }

      const rawItems = items.map((item) => ({
        id: item.id,
        name: item.name,
        filePath: item.filePath,
        nodeType: item.nodeType,
        depth: item.depth,
        summary: item.summary && item.summary !== "pending_summary" ? item.summary : undefined,
        isTest: item.filePath.includes(".test.") || item.filePath.includes(".spec.") || item.filePath.includes("/tests/"),
        viaCycle: !!item.viaCycle
      }));

      const page = paginateItems(rawItems, limit, cursor, 50);

      const meta = await EnvelopeBuilder.createMeta(store, max_tokens, ["get_symbol", "get_file_contract"], repoRoot);
      return EnvelopeBuilder.wrap(
        {
          target: {
            id: node.id,
            name: node.name,
            sourcePointer: formatPointer(node.filePath, node.startLine, node.endLine)
          },
          total: page.total,
          returned: page.returned,
          next_cursor: page.next_cursor,
          totalImpactedFiles: affectedFiles.size,
          maxDepthReached: Math.max(0, ...items.map((i) => i.depth)),
          impactedSymbols: page.items
        },
        meta
      );
    }
  );

  // -------------------------------------------------------------------------
  // 8. get_owners
  // -------------------------------------------------------------------------
  server.tool(
    "get_owners",
    `View top git contributors, line percentages, and authorship history.`,
    {
      id_or_path: z.string().describe("Symbol ID, function name, or relative file path"),
      max_tokens: z.number().optional().describe("Maximum response token budget (default 2000, cap 8000)")
    },
    async ({ id_or_path, max_tokens }) => {
      const node = await store.getNode(id_or_path);
      const nodeId = node ? node.id : id_or_path;
      const ownership = await store.getOwnership(nodeId);

      const meta = await EnvelopeBuilder.createMeta(store, max_tokens, ["get_symbol"], repoRoot);
      return EnvelopeBuilder.wrap(
        {
          target: node ? node.name : id_or_path,
          contributorsCount: ownership.length,
          contributors: ownership.slice(0, 5).map((o) => ({
            authorName: o.authorName,
            linesAuthored: o.linesAuthored,
            ownershipPercentage: o.ownershipPercentage,
            lastCommitDate: o.lastCommitDate,
            totalCommits: o.totalCommits
          }))
        },
        meta
      );
    }
  );

  // -------------------------------------------------------------------------
  // 9. get_architecture_summary
  // -------------------------------------------------------------------------
  server.tool(
    "get_architecture_summary",
    `Get high-level repository architecture overview or onboarding guide. ${TOOL_NOTE}`,
    {
      section: z.enum(["overview", "onboarding", "modules"]).optional().describe("Section to return (default: overview)"),
      max_tokens: z.number().optional().describe("Maximum response token budget (default 2000, cap 8000)")
    },
    async ({ section = "overview", max_tokens }) => {
      const repo = await store.getRepository(repoId);
      const overview = repo?.architectureSummary || "Architecture summary has not been generated yet. Run 'oss-analyser summarize' to produce.";
      const onboarding = repo?.onboardingGuide || "Onboarding guide has not been generated yet.";

      const meta = await EnvelopeBuilder.createMeta(store, max_tokens, ["get_module_summary", "search_symbols"], repoRoot);

      if (section === "onboarding") {
        return EnvelopeBuilder.wrap({ onboardingGuide: onboarding }, meta);
      }
      return EnvelopeBuilder.wrap({ architectureSummary: overview }, meta);
    }
  );

  // -------------------------------------------------------------------------
  // 10. index_status
  // -------------------------------------------------------------------------
  server.tool(
    "index_status",
    `Check the status and freshness of the local OSS Analyser knowledge database.`,
    {},
    async () => {
      const lastCommit = (await store.getMeta("last_indexed_commit")) || "none";
      const dirty = (await store.getMeta("last_indexed_dirty")) === "true";
      const indexedAt = (await store.getMeta("last_indexed_at")) || "never";

      const allNodes = await store.getAllNodes(repoId);
      const symbols = allNodes.filter((n) => n.nodeType === "function" || n.nodeType === "method" || n.nodeType === "class");
      const files = allNodes.filter((n) => n.nodeType === "file");

      const missingSummaries = symbols.filter((s) => s.summaryStatus === "missing").length;
      const coveragePct = symbols.length > 0 ? Math.round(((symbols.length - missingSummaries) / symbols.length) * 100) : 0;

      const meta = await EnvelopeBuilder.createMeta(store, 2000, ["search_symbols", "get_architecture_summary"], repoRoot);
      return EnvelopeBuilder.wrap(
        {
          repository: repoRoot,
          lastIndexedCommit: lastCommit,
          workingTreeDirty: dirty,
          lastIndexedAt: indexedAt,
          totalFiles: files.length,
          totalSymbols: symbols.length,
          summaryCoveragePct: coveragePct
        },
        meta
      );
    }
  );

  // -------------------------------------------------------------------------
  // 11. get_relevant_context (Optional Decision-Maker Shortcut)
  // -------------------------------------------------------------------------
  server.tool(
    "get_relevant_context",
    `[Optional Shortcut] Automated context-bundling macro that executes multi-source search, RRF ranking, 1-hop caller expansion, and token-packed file contracts in a single call. Use this for quick bootstrapping; prefer driving your own traversal via search_symbols, get_symbol, and get_callers/get_blast_radius for precise, agent-controlled investigation. ${TOOL_NOTE}`,
    {
      task: z.string().describe("The coding task, issue description, or question about codebase"),
      max_tokens: z.number().optional().describe("Maximum response token budget (default 2000, cap 8000)"),
      focus_paths: z.array(z.string()).optional().describe("Optional list of file paths to boost or filter on")
    },
    async ({ task, max_tokens, focus_paths }) => {
      await ensureEmbedded();
      const contextPackage = await buildContext(
        task,
        {
          repoId,
          repoRoot,
          maxTokens: max_tokens,
          focusPaths: focus_paths,
          embeddingProvider: eProvider,
          vectorEngine: vEngine
        },
        store
      );

      const meta = await EnvelopeBuilder.createMeta(
        store,
        max_tokens,
        contextPackage.suggestedNextTools,
        repoRoot
      );

      return EnvelopeBuilder.wrap(contextPackage, meta);
    }
  );

  // -------------------------------------------------------------------------
  // 12. get_unsummarized_nodes (Agent Backfill Helper)
  // -------------------------------------------------------------------------
  server.tool(
    "get_unsummarized_nodes",
    "Find code symbols or files that lack summaries, enabling the AI harness (Antigravity/Claude Code) to inspect and backfill them without external API keys.",
    {
      limit: z.number().min(1).max(50).optional().describe("Number of items to return (default: 20)"),
      file_path: z.string().optional().describe("Optional filter to a specific source file")
    },
    async ({ limit = 20, file_path }) => {
      const allNodes = await store.getAllNodes(repoId);
      let pending = allNodes.filter(
        (n) => n.summaryStatus === "missing" || !n.summary || n.summary === "pending_summary"
      );
      if (file_path) {
        const norm = normalizeRelPath(file_path);
        pending = pending.filter((n) => n.filePath === norm);
      }
      const items = pending.slice(0, limit).map((n) => ({
        id: n.id,
        name: n.name,
        nodeType: n.nodeType,
        filePath: n.filePath,
        signature: n.signature,
        sourcePointer: formatPointer(n.filePath, n.startLine, n.endLine),
        rawCodeSnippet: n.rawCode ? n.rawCode.slice(0, 500) : undefined
      }));
      const meta = await EnvelopeBuilder.createMeta(store, 2000, ["save_symbol_summary", "save_file_contract"], repoRoot);
      return EnvelopeBuilder.wrap({ totalPending: pending.length, returned: items.length, nodes: items }, meta);
    }
  );

  // -------------------------------------------------------------------------
  // 13. save_symbol_summary (Zero-Key Agent Backfill Tool)
  // -------------------------------------------------------------------------
  server.tool(
    "save_symbol_summary",
    "Persist an agent-generated summary contract for a symbol into knowledge.db, automatically updating FTS5 and generating local 768-d vector embeddings without an external API key.",
    {
      id_or_name: z.string().describe("Symbol ID or function/class name"),
      summary: z.string().describe("1-3 sentence architectural contract describing symbol responsibilities, inputs, and side effects"),
      embed: z.boolean().optional().describe("Whether to immediately embed with the local 768-d model (default: true)")
    },
    async ({ id_or_name, summary, embed = true }) => {
      const node = await store.getNode(id_or_name);
      if (!node) {
        const meta = await EnvelopeBuilder.createMeta(store, 1000, ["search_symbols"], repoRoot);
        return EnvelopeBuilder.wrap({ error: `Symbol not found: '${id_or_name}'` }, meta);
      }

      node.summary = summary;
      node.summaryStatus = "fresh";
      await store.upsertNodes([node]);

      let embeddedSuccess = false;
      if (embed && store instanceof SQLiteStore && store.isVecAvailable()) {
        try {
          const embedText = vEngine.getEmbeddedTextForNode(node);
          const [vec] = await eProvider.embed([embedText], "document");
          store.upsertVecEmbedding(node.id, vec);
          embeddedSuccess = true;
        } catch (e) {
          console.error("[save_symbol_summary] Warning: failed to generate embedding:", e);
        }
      }

      const meta = await EnvelopeBuilder.createMeta(store, 1000, ["get_symbol", "get_relevant_context"], repoRoot);
      return EnvelopeBuilder.wrap(
        {
          success: true,
          nodeId: node.id,
          name: node.name,
          summary: node.summary,
          summaryStatus: node.summaryStatus,
          vectorEmbedded: embeddedSuccess
        },
        meta
      );
    }
  );

  // -------------------------------------------------------------------------
  // 14. save_file_contract (Zero-Key Agent Backfill Tool)
  // -------------------------------------------------------------------------
  server.tool(
    "save_file_contract",
    "Persist an agent-generated architectural contract for an entire source file/module into knowledge.db.",
    {
      path: z.string().describe("Relative file path (e.g. src/routing.py)"),
      summary: z.string().describe("Overview contract describing file responsibilities, exported capabilities, and key dependencies")
    },
    async ({ path: userPath, summary }) => {
      assertSafePath(repoRoot, userPath);
      const normPath = normalizeRelPath(userPath);
      const nodes = await store.getNodesByFilePath(normPath);
      const fileNode = nodes.find((n) => n.nodeType === "file");
      if (!fileNode) {
        const meta = await EnvelopeBuilder.createMeta(store, 1000, ["get_file_contract"], repoRoot);
        return EnvelopeBuilder.wrap({ error: `File not found in index: '${userPath}'` }, meta);
      }

      fileNode.summary = summary;
      fileNode.summaryStatus = "fresh";
      await store.upsertNodes([fileNode]);

      if (store instanceof SQLiteStore && store.isVecAvailable()) {
        try {
          const embedText = vEngine.getEmbeddedTextForNode(fileNode);
          const [vec] = await eProvider.embed([embedText], "document");
          store.upsertVecEmbedding(fileNode.id, vec);
        } catch {}
      }

      const meta = await EnvelopeBuilder.createMeta(store, 1000, ["get_file_contract"], repoRoot);
      return EnvelopeBuilder.wrap(
        {
          success: true,
          filePath: normPath,
          summary: fileNode.summary,
          summaryStatus: fileNode.summaryStatus
        },
        meta
      );
    }
  );

  // -------------------------------------------------------------------------
  // 15. get_summary_batch (Agent-Driven Hierarchical Summarization)
  // -------------------------------------------------------------------------
  server.tool(
    "get_summary_batch",
    "Fetch the next topological batch of functions needing summaries for harness agent-driven summarization using the harness's own model.",
    {
      max_items: z.number().min(1).max(50).optional().describe("Maximum items per batch (default: 25)"),
      include_possibly_stale: z.boolean().optional().describe("Include functions whose callers/dependencies were updated (default: false)"),
      file_path: z.string().optional().describe("Optional filter to a specific source file")
    },
    async ({ max_items = 25, include_possibly_stale = false, file_path }) => {
      const result = await getNextAgentBatch(store, repoId, repoRoot, {
        maxItemsPerBatch: max_items,
        includePossiblyStale: include_possibly_stale,
        filePath: file_path ? normalizeRelPath(file_path) : undefined
      });
      const meta = await EnvelopeBuilder.createMeta(store, 4000, ["save_summary_batch"], repoRoot);
      return EnvelopeBuilder.wrap(result, meta);
    }
  );

  // -------------------------------------------------------------------------
  // 16. save_summary_batch (Agent-Driven Hierarchical Summarization)
  // -------------------------------------------------------------------------
  server.tool(
    "save_summary_batch",
    "Persist a batch of harness-generated summaries into knowledge.db, updating input/content hashes and invalidating callers if needed.",
    {
      summaries: z.array(
        z.object({
          nodeId: z.string().describe("ID of the code node"),
          summary: z.string().describe("1-3 sentence architectural summary of responsibility and behavior")
        })
      ).describe("Array of node summaries generated by the harness")
    },
    async ({ summaries }) => {
      const result = await saveAgentBatch(store, repoId, repoRoot, summaries);
      const meta = await EnvelopeBuilder.createMeta(store, 2000, ["get_summary_batch", "get_symbol"], repoRoot);
      return EnvelopeBuilder.wrap(result, meta);
    }
  );

  // -------------------------------------------------------------------------
  // 17. reset_summaries (Enable Re-Summarization via Harness)
  // -------------------------------------------------------------------------
  server.tool(
    "reset_summaries",
    "Reset symbol summaries in knowledge.db to 'missing' or 'stale' status, enabling a full or partial re-summarization by the harness.",
    {
      scope: z.enum(["all", "possibly_stale", "heuristic"]).optional().describe("Scope to reset: 'all' (entire codebase), 'possibly_stale' (only modified caller dependencies), or 'heuristic' (only rule-based fallback summaries) (default: all)"),
      file_path: z.string().optional().describe("Optional filter to reset a single file")
    },
    async ({ scope = "all", file_path }) => {
      const result = await resetRepoSummaries(store, repoId, {
        scope,
        filePath: file_path ? normalizeRelPath(file_path) : undefined
      });
      const meta = await EnvelopeBuilder.createMeta(store, 1000, ["get_summary_batch"], repoRoot);
      return EnvelopeBuilder.wrap(result, meta);
    }
  );

  return server;
}

export async function startMcpStdioServer(repoRoot: string): Promise<void> {
  const dbPath = path.join(repoRoot, ".oss-analyser", "knowledge.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`Knowledge database not found at ${dbPath}. Run 'oss-analyser init' and 'oss-analyser index' first.`);
    process.exit(1);
  }

  const repoName = path.basename(repoRoot);
  const repoId = `repo_${repoName.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  const store = new SQLiteStore(dbPath);
  await store.init();

  const server = createMcpServer(store, repoRoot, repoId);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  // Log strictly to stderr so stdout is reserved for MCP JSON-RPC protocol
  console.error(`[McpServer] OSS Analyser stdio server running for ${repoRoot}`);
}
