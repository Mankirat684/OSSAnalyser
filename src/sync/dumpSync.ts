import * as fs from "node:fs";
import * as path from "node:path";
import type { GraphStore, RepoRecord, NodeRecord, GitOwnershipRecord } from "../storage/graphStore.js";

export interface KnowledgeGraphDump {
  version: number;
  exportedAt: string;
  repository: RepoRecord;
  nodes: NodeRecord[];
  edges: Array<{
    sourceId: string;
    targetId: string;
    relation: string;
    confidence: "EXTRACTED" | "INFERRED";
    metadata?: Record<string, unknown>;
  }>;
  ownership: GitOwnershipRecord[];
}

export class DumpSync {
  public static async exportToJson(
    store: GraphStore,
    repoId: string,
    outputPath: string
  ): Promise<{ nodesCount: number; edgesCount: number; sizeBytes: number }> {
    const repo = await store.getRepository(repoId);
    if (!repo) {
      throw new Error(`Repository with ID '${repoId}' not found.`);
    }

    const nodes = await store.getAllNodes(repoId);
    const edges: KnowledgeGraphDump["edges"] = [];
    const ownershipList: GitOwnershipRecord[] = [];

    for (const n of nodes) {
      const deps = await store.getDependencies(n.id, 1, true);
      for (const d of deps) {
        edges.push({
          sourceId: n.id,
          targetId: d.id,
          relation: d.relation,
          confidence: (d.confidence as "EXTRACTED" | "INFERRED") || "EXTRACTED",
          metadata: d.line ? { line: d.line } : undefined
        });
      }

      const own = await store.getOwnership(n.id);
      if (own.length > 0) {
        ownershipList.push(...own);
      }
    }

    const dump: KnowledgeGraphDump = {
      version: 1,
      exportedAt: new Date().toISOString(),
      repository: repo,
      nodes,
      edges,
      ownership: ownershipList
    };

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const jsonStr = JSON.stringify(dump, null, 2);
    fs.writeFileSync(outputPath, jsonStr, "utf-8");

    return {
      nodesCount: nodes.length,
      edgesCount: edges.length,
      sizeBytes: Buffer.byteLength(jsonStr, "utf-8")
    };
  }

  public static async importFromJson(
    store: GraphStore,
    inputPath: string
  ): Promise<{ repoName: string; nodesImported: number; edgesImported: number }> {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Dump file not found at: ${inputPath}`);
    }

    const raw = fs.readFileSync(inputPath, "utf-8");
    const dump = JSON.parse(raw) as KnowledgeGraphDump;

    if (!dump.repository || !Array.isArray(dump.nodes)) {
      throw new Error("Invalid knowledge graph dump file format.");
    }

    // 1. Save Repository
    await store.saveRepository(dump.repository);

    // 2. Save Nodes
    await store.upsertNodes(dump.nodes);

    // 3. Save Edges
    if (dump.edges && dump.edges.length > 0) {
      await store.upsertEdges(
        dump.edges.map((e) => ({
          repoId: dump.repository.id,
          sourceId: e.sourceId,
          targetId: e.targetId,
          relation: e.relation as "calls" | "contains" | "imports" | "references",
          confidence: e.confidence,
          metadata: e.metadata || {}
        }))
      );
    }

    // 4. Save Ownership
    if (dump.ownership && dump.ownership.length > 0) {
      await store.saveOwnership(dump.ownership);
    }

    return {
      repoName: dump.repository.name,
      nodesImported: dump.nodes.length,
      edgesImported: dump.edges?.length || 0
    };
  }
}
