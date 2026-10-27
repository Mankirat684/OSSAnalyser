import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import type { GraphStore, NodeRecord, EdgeRecord, GitOwnershipRecord } from "../storage/graphStore.js";
import { IncrementalDetector } from "./incremental.js";
import { NativeExtractor } from "./extractors/native.js";
import { GraphifyExtractor } from "./extractors/graphify.js";
import { EdgeResolver } from "./resolver.js";
import { InvalidationManager } from "./invalidation.js";
import { extractGitOwnershipForRange, type GitBlameCache } from "../modules/git/gitBlame.js";
import { condenseGraphWithTarjan } from "../modules/analyzer/tarjan.js";
import { computeBottomUpTopoLevels } from "../modules/analyzer/topoSort.js";
import type { CodeNode } from "../core/types.js";
import { NodeIdGenerator } from "./idGenerator.js";

export interface IndexOptions {
  repoRoot: string;
  repoId?: string;
  repoName?: string;
  full?: boolean;
  noBlame?: boolean;
  extractor?: "native" | "graphify";
}

export interface IndexStats {
  filesScanned: number;
  filesChanged: number;
  totalSymbols: number;
  extractedEdges: number;
  inferredEdges: number;
  unresolvedRefs: number;
  sccCycles: number;
  durationMs: number;
}

export async function runIndexingPipeline(
  store: GraphStore,
  options: IndexOptions
): Promise<IndexStats> {
  const startTime = Date.now();
  const repoRoot = path.resolve(options.repoRoot);
  const repoName = options.repoName || path.basename(repoRoot);
  const repoId = options.repoId || `repo_${repoName.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  // 1. Ensure Repository record
  await store.saveRepository({
    id: repoId,
    name: repoName,
    rootPath: repoRoot,
    status: "indexing",
    indexedAt: new Date().toISOString()
  });

  // 2. Incremental Change Detection
  const changeSet = await IncrementalDetector.detectChanges(repoRoot, repoId, store);
  const filesToExtract = options.full
    ? Array.from(changeSet.allCurrentFiles.keys())
    : [...changeSet.added, ...changeSet.modified];

  const idGen = new NodeIdGenerator();
  const extractor = options.extractor === "graphify" ? new GraphifyExtractor() : new NativeExtractor();
  const resolver = new EdgeResolver();
  const blameCache: GitBlameCache = new Map();

  // 3. Handle Deleted Files
  if (changeSet.deleted.length > 0) {
    for (const delPath of changeSet.deleted) {
      const fileNodes = await store.getNodesByFilePath(delPath);
      const nodeIdsToDelete = fileNodes.map((n) => n.id);
      // Also delete the file node itself
      const fileNodeId = idGen.makeNodeId(delPath, delPath, "file");
      nodeIdsToDelete.push(fileNodeId);
      await store.deleteNodes(nodeIdsToDelete);
    }
  }

  // 4. Extract symbols & edges from added/modified files
  if (filesToExtract.length > 0) {
    const extraction = await extractor.extract(filesToExtract, { repoRoot });

    // Build NodeRecords for symbols
    const symbolNodes: NodeRecord[] = extraction.symbols.map((s) => ({
      id: s.id,
      repoId,
      nodeType: s.nodeType,
      name: s.name,
      filePath: s.filePath,
      startLine: s.startLine,
      endLine: s.endLine,
      startColumn: s.startColumn,
      endColumn: s.endColumn,
      signature: s.signature,
      rawCode: s.rawCode,
      summary: "pending_summary",
      level: 0,
      metadata: {
        qualified_name: s.qualifiedName,
        exported: s.exported,
        doc_comment: s.docComment
      },
      displayId: s.displayId,
      sourceHash: s.sourceHash,
      summaryStatus: "missing"
    }));

    // Build NodeRecords for files
    const fileNodes: NodeRecord[] = filesToExtract.map((fPath) => {
      const fHash = changeSet.allCurrentFiles.get(fPath) || "";
      return {
        id: idGen.makeNodeId(fPath, fPath, "file"),
        repoId,
        nodeType: "file",
        name: path.basename(fPath),
        filePath: fPath,
        summary: "pending_summary",
        level: 10,
        sourceHash: fHash,
        summaryStatus: "missing"
      };
    });

    // Check previous hashes to mark staleness
    for (const sym of symbolNodes) {
      const existing = await store.getNode(sym.id);
      if (existing) {
        // If node already existed and had a summary
        if (existing.summary && existing.summary !== "pending_summary") {
          sym.summary = existing.summary;
          if (existing.sourceHash !== sym.sourceHash) {
            // Source changed! Mark stale and callers possibly_stale
            sym.summaryStatus = "stale";
            await InvalidationManager.propagateSourceChange(store, sym.id);
          } else {
            sym.summaryStatus = existing.summaryStatus || "fresh";
            sym.summaryInputHash = existing.summaryInputHash;
            sym.summaryContentHash = existing.summaryContentHash;
          }
        }
      }
    }

    // Upsert extracted nodes
    await store.upsertNodes([...fileNodes, ...symbolNodes]);

    // For changed files, delete their outgoing edges before replacing them
    const sourceIdsToDelete = symbolNodes.map((s) => s.id);
    await store.deleteOutgoingEdges(sourceIdsToDelete);
    await store.deleteUnresolvedRefsForSources(sourceIdsToDelete);

    // Resolve edges across the whole codebase
    const allKnownSymbols = (await store.getAllNodes(repoId)).filter(
      (n) => n.nodeType === "function" || n.nodeType === "method" || n.nodeType === "class"
    ).map((n) => ({
      id: n.id,
      displayId: n.displayId || n.id,
      name: n.name,
      qualifiedName: (n.metadata as any)?.qualified_name || n.name,
      nodeType: n.nodeType as any,
      filePath: n.filePath,
      startLine: n.startLine || 1,
      endLine: n.endLine || 1,
      signature: n.signature || "",
      exported: true,
      sourceHash: n.sourceHash || ""
    }));

    // Include unresolved refs from before
    const prevUnresolved = await store.getUnresolvedRefs(repoId);
    const edgesToResolve = [
      ...extraction.edges,
      ...prevUnresolved.map((u) => ({
        sourceId: u.sourceId,
        targetName: u.targetName,
        relation: u.relation as any,
        confidence: u.confidence as any,
        line: u.line ?? undefined
      }))
    ];

    const resolveRes = resolver.resolve(repoId, edgesToResolve, allKnownSymbols);
    await store.upsertEdges(resolveRes.edges);
    await store.saveUnresolvedRefs(resolveRes.unresolved);

    // 5. Git Blame (if enabled)
    if (!options.noBlame) {
      const ownershipRecords: GitOwnershipRecord[] = [];
      for (const sym of symbolNodes) {
        if (!sym.startLine || !sym.endLine) continue;
        const authors = extractGitOwnershipForRange(
          repoRoot,
          sym.filePath,
          sym.startLine,
          sym.endLine,
          blameCache
        );
        for (const auth of authors.slice(0, 3)) {
          ownershipRecords.push({
            repoId,
            nodeId: sym.id,
            authorName: auth.authorName,
            authorEmail: auth.authorEmail,
            linesAuthored: auth.linesAuthored,
            ownershipPercentage: auth.ownershipPercentage,
            lastCommitDate: auth.lastCommitDate,
            totalCommits: auth.totalCommits
          });
        }
      }
      if (ownershipRecords.length > 0) {
        await store.saveOwnership(ownershipRecords);
      }
    }
  }

  // 6. SCC Condensation and Topo Ordering (Over deterministic edges only)
  const allNodes = await store.getAllNodes(repoId);
  const symbolMap = new Map<string, CodeNode>();

  for (const n of allNodes) {
    if (n.nodeType === "function" || n.nodeType === "method" || n.nodeType === "class") {
      // Fetch deterministic callees/dependencies
      const deps = await store.getDependencies(n.id, 1, false);
      symbolMap.set(n.id, {
        id: n.id,
        label: n.name,
        dependencies: deps.map((d) => d.id),
        source_file: n.filePath,
        start_line: n.startLine ?? undefined,
        end_line: n.endLine ?? undefined,
        file_type: "code",
        is_callable: n.nodeType === "function" || n.nodeType === "method",
        is_class: n.nodeType === "class",
        callers: [],
        estimated_tokens: 0
      });
    }
  }

  let sccCount = 0;
  if (symbolMap.size > 0) {
    const dag = condenseGraphWithTarjan(symbolMap);
    const topo = computeBottomUpTopoLevels(dag);

    // Update scc_id and level on code_nodes
    const nodesToUpdate: NodeRecord[] = [];
    let sccNumericId = 1;

    for (const [compId, comp] of dag.components.entries()) {
      const isCycle = comp.nodes.length > 1;
      const sccIdToAssign = isCycle ? sccNumericId++ : null;
      if (isCycle) sccCount++;

      const level = topo.componentLevelMap.get(compId) ?? 0;

      for (const node of comp.nodes) {
        const existingNode = allNodes.find((n) => n.id === node.id);
        if (existingNode) {
          existingNode.sccId = sccIdToAssign;
          existingNode.level = level;
          nodesToUpdate.push(existingNode);
        }
      }
    }

    if (nodesToUpdate.length > 0) {
      await store.upsertNodes(nodesToUpdate);
    }
  }

  // 7. Update Git Commit Meta
  try {
    const gitHead = execSync("git rev-parse HEAD", { cwd: repoRoot, stdio: ["pipe", "pipe", "ignore"] })
      .toString()
      .trim();
    const gitDirty = execSync("git status --porcelain", { cwd: repoRoot, stdio: ["pipe", "pipe", "ignore"] })
      .toString()
      .trim().length > 0;
    await store.setMeta("last_indexed_commit", gitHead);
    await store.setMeta("last_indexed_dirty", gitDirty ? "true" : "false");
    await store.setMeta("last_indexed_at", new Date().toISOString());
  } catch {
    // Non-git repo fallback
  }

  // Finalize Repository record
  await store.saveRepository({
    id: repoId,
    name: repoName,
    rootPath: repoRoot,
    status: "indexed",
    checkpointData: {
      filesCount: changeSet.allCurrentFiles.size,
      symbolsCount: symbolMap.size,
      sccCycles: sccCount,
      indexedAt: new Date().toISOString()
    }
  });

  const durationMs = Date.now() - startTime;
  const currentNodes = await store.getAllNodes(repoId);
  const callersSample = await store.searchNodesFts("", 1000);

  return {
    filesScanned: changeSet.allCurrentFiles.size,
    filesChanged: filesToExtract.length,
    totalSymbols: symbolMap.size,
    extractedEdges: callersSample.length,
    inferredEdges: 0,
    unresolvedRefs: (await store.getUnresolvedRefs(repoId)).length,
    sccCycles: sccCount,
    durationMs
  };
}
